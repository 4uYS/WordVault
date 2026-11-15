package com.wordvault.app;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 附近设备同步的原生实现。
 *
 * 蓝牙只用来「发现」：BLE Service Data 广播里放 9 字节 beacon（本机局域网 IP + 端口），
 * 扫描到即对端可直连；备份 JSON 一律走局域网 HTTP，不占用 BLE 带宽。
 *
 * HTTP 端点（仅局域网，扫描期间开启）：
 *   GET  /wordvault/ping          连通性与身份校验
 *   GET  /wordvault/backup        拉取本机托管的备份
 *   POST /wordvault/backup        推送备份给本机，前端弹确认后才导入
 *   OPTIONS *                     CORS 预检（WebView 的 file:// origin 为 null）
 */
public class NearbyBridge {

    public static final int REQUEST_NEARBY_PERMISSIONS = 2002;
    static final String SERVICE_UUID = "0000fa57-0000-1000-8000-00805f9b34fb";
    private static final int DEFAULT_PORT = 8765;
    private static final int BEACON_SIZE = 9;
    private static final int MAX_BODY = 64 * 1024 * 1024;
    private static final long PEER_TTL_MS = 45000L;

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final Map<String, Peer> peers = new LinkedHashMap<>();

    private ServerSocket serverSocket;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private AdvertiseCallback advertiseCallback;
    private ScanCallback scanCallback;
    private volatile String hostedBackup = null;
    private String localIp = null;
    private int port = DEFAULT_PORT;

    private static class Peer {
        final String id, ip;
        final int port;
        int flags;
        long seenAt;

        Peer(String ip, int port, int flags) {
            this.ip = ip;
            this.port = port;
            this.flags = flags;
            this.id = ip + ":" + port;
            this.seenAt = System.currentTimeMillis();
        }
    }

    NearbyBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /* ---------------- 由 WebBridge 转发的 JS 接口 ---------------- */

    String endpoint() {
        return localIp == null ? "" : localIp + ":" + port;
    }

    void setBackup(String content) {
        hostedBackup = content;
        restartAdvertising();   // 更新 flags 里的「已托管备份」位
    }

    void start() {
        if (running.getAndSet(true)) return;
        localIp = findLanIp();
        if (localIp == null) {
            status("未检测到局域网地址，请连接 Wi-Fi 后重试");
            running.set(false);
            return;
        }
        if (!hasBluetoothPermissions()) {
            requestBluetoothPermissions();
            // 权限回来后由 onRequestPermissionsResult 再次 start
            running.set(false);
            return;
        }
        try {
            startServer();
        } catch (Exception error) {
            status("局域网服务启动失败：" + error.getMessage());
            running.set(false);
            return;
        }
        startBluetooth();
        status("正在广播本机地址并扫描附近设备");
        publishPeers();
    }

    void stop() {
        if (!running.getAndSet(false)) return;
        stopBluetooth();
        closeServer();
        synchronized (peers) { peers.clear(); }
        publishPeers();
    }

    void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_NEARBY_PERMISSIONS) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            start();
        } else {
            status("蓝牙权限被拒绝，可在下方手动输入对方 IP:端口");
        }
    }

    void destroy() {
        stop();
        io.shutdownNow();
    }

    /* ---------------- 权限 ---------------- */

    private boolean hasBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return granted(Manifest.permission.BLUETOOTH_ADVERTISE)
                    && granted(Manifest.permission.BLUETOOTH_SCAN)
                    && granted(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean granted(String permission) {
        return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestBluetoothPermissions() {
        String[] needed;
        if (Build.VERSION.SDK_INT >= 31) {
            needed = new String[]{
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT,
            };
        } else {
            needed = new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
        }
        activity.requestPermissions(needed, REQUEST_NEARBY_PERMISSIONS);
    }

    /* ---------------- 局域网地址 ---------------- */

    private static boolean isLan(String ip) {
        if (ip == null || !ip.contains(".")) return false;
        String[] p = ip.split("\\.");
        if (p.length != 4) return false;
        int a = Integer.parseInt(p[0]);
        int b = Integer.parseInt(p[1]);
        return a == 10 || a == 127
                || (a == 192 && b == 168)
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 169 && b == 254);
    }

    private String findLanIp() {
        try {
            WifiManager manager = (WifiManager) activity.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (manager != null) {
                int ip = manager.getConnectionInfo().getIpAddress();
                if (ip != 0) {
                    String candidate = String.format(Locale.ROOT, "%d.%d.%d.%d",
                            ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >> 24) & 0xff);
                    if (isLan(candidate)) return candidate;
                }
            }
        } catch (Exception ignored) { /* 退回枚举网卡 */ }
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                Enumeration<InetAddress> addresses = ni.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (addr.isLoopbackAddress() || addr.getAddress().length != 4) continue;
                    String host = addr.getHostAddress();
                    if (isLan(host)) return host;
                }
            }
        } catch (Exception ignored) { /* 无可用地址 */ }
        return null;
    }

    /* ---------------- BLE 广播 / 扫描 ---------------- */

    private byte[] beacon() {
        byte[] b = new byte[BEACON_SIZE];
        b[0] = 0x57;   // 'W'
        b[1] = 1;      // version
        String[] parts = localIp.split("\\.");
        for (int i = 0; i < 4; i += 1) b[2 + i] = (byte) Integer.parseInt(parts[i]);
        b[6] = (byte) (port >> 8);
        b[7] = (byte) port;
        int flags = 1;  // 可接收
        if (hostedBackup != null) flags |= 2;   // 已托管备份
        b[8] = (byte) flags;
        return b;
    }

    private void startBluetooth() {
        try {
            BluetoothManager manager =
                    (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                status("请先开启系统蓝牙；局域网直连仍可手动输入地址使用");
                return;
            }
            advertiser = adapter.getBluetoothLeAdvertiser();
            scanner = adapter.getBluetoothLeScanner();
            if (advertiser != null) {
                AdvertiseData data = new AdvertiseData.Builder()
                        .setIncludeDeviceName(false)
                        .setIncludeTxPowerLevel(false)
                        .addServiceData(new ParcelUuid(UUID.fromString(SERVICE_UUID)), beacon())
                        .build();
                AdvertiseSettings settings = new AdvertiseSettings.Builder()
                        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                        .setConnectable(false)
                        .build();
                advertiseCallback = new AdvertiseCallback() {
                    @Override
                    public void onStartFailure(int errorCode) {
                        status("蓝牙广播未开启（错误 " + errorCode + "），请手动输入地址");
                    }
                };
                advertiser.startAdvertising(settings, data, advertiseCallback);
            }
            if (scanner != null) {
                scanCallback = new ScanCallback() {
                    @Override
                    public void onScanResult(int callbackType, ScanResult result) {
                        handleScanResult(result);
                    }
                };
                ScanSettings settings = new ScanSettings.Builder()
                        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
                // 广播里只有 Service Data，不额外占 Service UUID 字段（31 字节上限）
                scanner.startScan(Collections.emptyList(), settings, scanCallback);
            }
        } catch (SecurityException | IllegalStateException error) {
            status("蓝牙不可用：" + error.getMessage() + "，请手动输入地址");
        }
    }

    private void restartAdvertising() {
        if (!running.get() || advertiser == null || advertiseCallback == null) return;
        try {
            advertiser.stopAdvertising(advertiseCallback);
            AdvertiseData data = new AdvertiseData.Builder()
                    .setIncludeDeviceName(false)
                    .setIncludeTxPowerLevel(false)
                    .addServiceData(new ParcelUuid(UUID.fromString(SERVICE_UUID)), beacon())
                    .build();
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                    .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                    .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                    .setConnectable(false)
                    .build();
            advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (Exception ignored) { /* 保持原广播 */ }
    }

    private void stopBluetooth() {
        try {
            if (advertiser != null && advertiseCallback != null) {
                advertiser.stopAdvertising(advertiseCallback);
            }
            if (scanner != null && scanCallback != null) {
                scanner.stopScan(scanCallback);
            }
        } catch (Exception ignored) { /* 已停止 */ }
        advertiser = null;
        scanner = null;
        advertiseCallback = null;
        scanCallback = null;
    }

    private void handleScanResult(ScanResult result) {
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null) return;
        Map<ParcelUuid, byte[]> serviceData = record.getServiceData();
        if (serviceData == null) return;
        byte[] b = serviceData.get(new ParcelUuid(UUID.fromString(SERVICE_UUID)));
        if (b == null || b.length < BEACON_SIZE || b[0] != 0x57 || b[1] != 1) return;
        int a0 = b[2] & 0xff, a1 = b[3] & 0xff, a2 = b[4] & 0xff, a3 = b[5] & 0xff;
        String ip = a0 + "." + a1 + "." + a2 + "." + a3;
        int peerPort = ((b[6] & 0xff) << 8) | (b[7] & 0xff);
        int flags = b[8] & 0xff;
        if (!isLan(ip) || peerPort < 1 || peerPort > 65535) return;
        if (ip.equals(localIp) && peerPort == port) return;   // 忽略自己
        synchronized (peers) {
            Peer peer = peers.get(ip + ":" + peerPort);
            if (peer == null) {
                peers.put(ip + ":" + peerPort, new Peer(ip, peerPort, flags));
            } else {
                peer.flags = flags;
                peer.seenAt = System.currentTimeMillis();
            }
            long now = System.currentTimeMillis();
            peers.values().removeIf(p -> now - p.seenAt > PEER_TTL_MS);
        }
        publishPeers();
    }

    private void publishPeers() {
        JSONArray array = new JSONArray();
        synchronized (peers) {
            for (Peer peer : peers.values()) {
                try {
                    JSONObject item = new JSONObject();
                    item.put("id", peer.id);
                    item.put("name", "WordVault · " + peer.ip.substring(peer.ip.lastIndexOf('.') + 1));
                    item.put("ip", peer.ip);
                    item.put("port", peer.port);
                    item.put("hasBackup", (peer.flags & 2) != 0);
                    item.put("canReceive", (peer.flags & 1) != 0);
                    item.put("source", "ble");
                    item.put("url", "http://" + peer.ip + ":" + peer.port);
                    array.put(item);
                } catch (Exception ignored) { /* 跳过坏条目 */ }
            }
        }
        dispatchJs("window.dispatchEvent(new CustomEvent('wordvault:nearby-peers',{detail:"
                + array.toString() + "}))");
    }

    /* ---------------- 局域网 HTTP 服务 ---------------- */

    private void startServer() throws Exception {
        ServerSocket opened = null;
        for (int i = 0; i < 20 && opened == null; i += 1) {
            try {
                opened = new ServerSocket(DEFAULT_PORT + i, 16,
                        InetAddress.getByName("0.0.0.0"));
            } catch (IOException ignored) { /* 端口被占用则顺延 */ }
        }
        if (opened == null) throw new Exception("8765-8784 端口都被占用");
        serverSocket = opened;
        port = opened.getLocalPort();
        final ServerSocket listener = opened;
        Thread acceptThread = new Thread(() -> {
            while (running.get()) {
                try {
                    Socket socket = listener.accept();
                    io.execute(() -> handleConnection(socket));
                } catch (IOException error) {
                    if (!running.get()) break;
                }
            }
        }, "wordvault-nearby-http");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    private void closeServer() {
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) { }
        serverSocket = null;
    }

    private static String readLine(BufferedInputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') {
                if (line.length() > 0 && line.charAt(line.length() - 1) == '\r') {
                    line.setLength(line.length() - 1);
                }
                return line.toString();
            }
            line.append((char) c);
            if (line.length() > 8192) break;
        }
        return line.length() == 0 ? null : line.toString();
    }

    private void handleConnection(Socket socket) {
        try (Socket conn = socket) {
            conn.setSoTimeout(20000);
            BufferedInputStream in = new BufferedInputStream(conn.getInputStream());
            OutputStream out = conn.getOutputStream();
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.ROOT) : "";
            String path = parts.length > 1 ? parts[1] : "";
            int contentLength = 0;
            while (true) {
                String header = readLine(in);
                if (header == null || header.isEmpty()) break;
                if (header.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                    try {
                        contentLength = Integer.parseInt(
                                header.substring(header.indexOf(':') + 1).trim());
                    } catch (NumberFormatException ignored) { }
                }
            }
            if (contentLength < 0 || contentLength > MAX_BODY) {
                respond(out, 400, "{\"error\":\"bad length\"}");
                return;
            }
            byte[] body = new byte[contentLength];
            int offset = 0;
            while (offset < contentLength) {
                int read = in.read(body, offset, contentLength - offset);
                if (read < 0) break;
                offset += read;
            }

            if ("OPTIONS".equals(method)) {
                respond(out, 204, "");
            } else if ("GET".equals(method) && "/wordvault/ping".equals(path)) {
                respond(out, 200, "{\"app\":\"WordVault\",\"version\":1,\"nearby\":true}");
            } else if ("GET".equals(method) && "/wordvault/backup".equals(path)) {
                String payload = hostedBackup;
                if (payload == null) {
                    respond(out, 404, "{\"error\":\"no backup hosted\"}");
                } else {
                    respond(out, 200, payload);
                }
            } else if ("POST".equals(method) && "/wordvault/backup".equals(path)) {
                receiveBackup(out, new String(body, 0, offset, StandardCharsets.UTF_8));
            } else {
                respond(out, 404, "{\"error\":\"not found\"}");
            }
        } catch (Exception ignored) { /* 单个连接失败不影响服务 */ }
    }

    private void receiveBackup(OutputStream out, String text) throws IOException {
        String payload = text.startsWith("\uFEFF") ? text.substring(1) : text;
        if (!payload.contains("\"app\"") || !payload.contains("WordVault")
                || !payload.contains("\"data\"")) {
            respond(out, 400, "{\"error\":\"not a WordVault backup\"}");
            return;
        }
        // 不静默写库：交给前端弹确认。用 base64 传，避免 JSON 里的引号破坏 JS 字符串。
        String base64 = Base64.encodeToString(
                payload.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        dispatchJs("(function(){var b=atob('" + base64 + "');"
                + "var u=Uint8Array.from(b,function(c){return c.charCodeAt(0)});"
                + "var t=new TextDecoder('utf-8').decode(u);"
                + "window.dispatchEvent(new CustomEvent('wordvault:nearby-received',{detail:t}));})()");
        respond(out, 200, "{\"ok\":true}");
    }

    private void respond(OutputStream out, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String reason = code == 200 ? "OK" : code == 204 ? "No Content"
                : code == 404 ? "Not Found" : "Bad Request";
        String head = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    /* ---------------- 与 WebView 通信 ---------------- */

    private void dispatchJs(final String script) {
        main.post(() -> {
            try {
                if (webView != null) webView.evaluateJavascript(script, null);
            } catch (Exception ignored) { /* 页面已销毁 */ }
        });
    }

    private void status(final String text) {
        main.post(() -> Toast.makeText(activity, text, Toast.LENGTH_SHORT).show());
        try {
            dispatchJs("window.dispatchEvent(new CustomEvent('wordvault:nearby-status',{detail:"
                    + JSONObject.quote(text) + "}))");
        } catch (Exception ignored) { }
    }
}
