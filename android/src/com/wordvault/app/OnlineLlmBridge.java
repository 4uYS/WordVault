package com.wordvault.app;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Kilo Gateway（kilo-auto/free）在线模型桥接。
 * 浏览器里的 fetch 会被网关的跨域策略拦截，因此应用内改用原生 HTTP 请求，
 * 再把 SSE 增量文本通过 window.WordVaultOnline 回调给前端。
 */
public class OnlineLlmBridge {

    private static final String ENDPOINT = "https://ai-gateway.kilo.ai/api/v1/chat/completions";
    private static final String DEFAULT_MODEL = "kilo-auto/free";
    private static final int FLUSH_INTERVAL_MS = 70;

    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final StringBuilder pending = new StringBuilder();
    private volatile String streamId = null;
    private volatile HttpURLConnection connection = null;
    private volatile boolean cancelled = false;
    private long lastFlush = 0L;
    private boolean flushScheduled = false;

    public OnlineLlmBridge(WebView webView) {
        this.webView = webView;
    }

    private void emit(String script) {
        main.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript("window.WordVaultOnline&&" + script, null);
            }
        });
    }

    private static String quote(String text) {
        return JSONObject.quote(text == null ? "" : text);
    }

    private void done(String id, boolean ok, String message) {
        emit("onDone(" + quote(id) + "," + ok + "," + quote(message) + ")");
    }

    @JavascriptInterface
    public void generate(final String id, String rolesJson, String contentsJson,
                         String model, String apiKey, int maxTokens, double temperature) {
        final JSONArray messages = new JSONArray();
        try {
            JSONArray roles = new JSONArray(rolesJson);
            JSONArray contents = new JSONArray(contentsJson);
            int count = Math.min(roles.length(), contents.length());
            for (int i = 0; i < count; i += 1) {
                JSONObject message = new JSONObject();
                message.put("role", roles.getString(i));
                message.put("content", contents.getString(i));
                messages.put(message);
            }
        } catch (Exception error) {
            done(id, false, "参数错误：" + error.getMessage());
            return;
        }

        final String finalModel = model == null || model.trim().isEmpty() ? DEFAULT_MODEL : model.trim();
        final String finalKey = apiKey == null ? "" : apiKey.trim();
        final int tokens = Math.max(maxTokens, 768);
        final float temp = (float) temperature;

        cancelled = false;
        streamId = id;
        synchronized (pending) {
            pending.setLength(0);
        }

        io.execute(() -> stream(id, messages, finalModel, finalKey, tokens, temp));
    }

    private void stream(String id, JSONArray messages, String model, String apiKey, int maxTokens, float temperature) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection = conn;
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(90000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "text/event-stream");
            if (!apiKey.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            }

            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", messages);
            body.put("stream", true);
            body.put("max_tokens", maxTokens);
            body.put("temperature", temperature);

            OutputStream output = conn.getOutputStream();
            output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            output.close();

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                String detail = readAll(conn.getErrorStream());
                flushTokens(true);
                done(id, false, "在线 AI 返回 " + code + (detail.isEmpty() ? "" : "：" + trimDetail(detail)));
                return;
            }

            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                if (cancelled) break;
                String text = line.trim();
                if (!text.startsWith("data:")) continue;
                String payload = text.substring(5).trim();
                if (payload.isEmpty() || "[DONE]".equals(payload)) continue;
                try {
                    JSONObject json = new JSONObject(payload);
                    JSONArray choices = json.optJSONArray("choices");
                    if (choices == null || choices.length() == 0) continue;
                    JSONObject delta = choices.getJSONObject(0).optJSONObject("delta");
                    if (delta == null) continue;
                    String piece = delta.optString("content", "");
                    if (piece.isEmpty()) piece = delta.optString("reasoning", "");
                    if (!piece.isEmpty()) appendToken(id, piece);
                } catch (Exception ignored) {
                    // 忽略无法解析的 SSE 帧
                }
            }
            reader.close();
            flushTokens(true);
            if (cancelled) {
                done(id, false, "生成已停止");
            } else {
                done(id, true, "");
            }
        } catch (Exception error) {
            flushTokens(true);
            done(id, false, cancelled ? "生成已停止" : "网络请求失败：" + error.getMessage());
        } finally {
            connection = null;
            if (conn != null) conn.disconnect();
        }
    }

    @JavascriptInterface
    public void cancel() {
        cancelled = true;
        HttpURLConnection conn = connection;
        if (conn != null) conn.disconnect();
    }

    private static String readAll(InputStream input) {
        if (input == null) return "";
        try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
            StringBuilder builder = new StringBuilder();
            char[] buffer = new char[2048];
            int read;
            while ((read = reader.read(buffer)) > 0) {
                builder.append(buffer, 0, read);
                if (builder.length() > 4096) break;
            }
            return builder.toString();
        } catch (Exception error) {
            return "";
        }
    }

    private static String trimDetail(String text) {
        String value = text.replaceAll("\\s+", " ").trim();
        return value.length() > 160 ? value.substring(0, 160) : value;
    }

    private void appendToken(String id, String text) {
        synchronized (pending) {
            if (!id.equals(streamId)) return;
            pending.append(text);
            long now = SystemClock.uptimeMillis();
            if (now - lastFlush >= FLUSH_INTERVAL_MS) {
                lastFlush = now;
                flushLocked();
            } else if (!flushScheduled) {
                flushScheduled = true;
                main.postDelayed(this::flushTokens, FLUSH_INTERVAL_MS);
            }
        }
    }

    private void flushTokens() {
        flushTokens(false);
    }

    private void flushTokens(boolean force) {
        synchronized (pending) {
            flushScheduled = false;
            long now = SystemClock.uptimeMillis();
            if (!force && now - lastFlush < FLUSH_INTERVAL_MS) {
                if (!flushScheduled) {
                    flushScheduled = true;
                    main.postDelayed(this::flushTokens, FLUSH_INTERVAL_MS);
                }
                return;
            }
            lastFlush = now;
            flushLocked();
        }
    }

    private void flushLocked() {
        if (pending.length() == 0 || streamId == null) return;
        String text = pending.toString();
        pending.setLength(0);
        emit("onToken(" + quote(streamId) + "," + quote(text) + ")");
    }

    public void destroy() {
        cancel();
        io.shutdownNow();
    }
}
