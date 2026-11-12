package com.wordvault.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 暴露给 WebView 的本地模型桥接对象，方法名与前端 src/lib/llm.js 一一对应。
 */
public class LlmBridge {

    private static final int FLUSH_INTERVAL_MS = 70;

    private final Activity activity;
    private final WebView webView;
    private final LlmEngine engine = new LlmEngine();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final StringBuilder pending = new StringBuilder();
    private String streamId = null;
    private long lastFlush = 0L;
    private boolean flushScheduled = false;

    public LlmBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    private File modelsDir() {
        File dir = new File(activity.getFilesDir(), "models");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File modelFile() {
        return new File(modelsDir(), "model.gguf");
    }

    private void emit(String script) {
        main.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript("window.WordVaultLlm&&" + script, null);
            }
        });
    }

    private static String quote(String text) {
        return JSONObject.quote(text == null ? "" : text);
    }

    private String statusJson() {
        JSONObject json = new JSONObject();
        try {
            File file = modelFile();
            boolean hasModel = file.isFile() && file.length() > 0;
            json.put("native", LlmEngine.isLibraryLoaded());
            json.put("hasModel", hasModel);
            json.put("loaded", engine.isLoaded());
            json.put("loading", engine.isLoading());
            json.put("size", hasModel ? file.length() : 0);
            json.put("name", hasModel ? file.getName() : "");
            json.put("abi", android.os.Build.SUPPORTED_ABIS.length > 0
                    ? android.os.Build.SUPPORTED_ABIS[0] : "unknown");
            json.put("error", LlmEngine.loadError());
        } catch (Exception error) {
            return "{\"native\":false,\"hasModel\":false,\"loaded\":false,\"loading\":false,\"size\":0,\"error\":"
                    + quote(error.toString()) + "}";
        }
        return json.toString();
    }

    @JavascriptInterface
    public String status() {
        return statusJson();
    }

    @JavascriptInterface
    public void importModel() {
        main.post(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES,
                    new String[]{"application/octet-stream", "application/x-gguf", "*/*"});
            try {
                activity.startActivityForResult(intent, MainActivity.REQUEST_PICK_MODEL);
            } catch (Exception error) {
                emit("onModelState(" + quote("无法打开文件选择器") + ")");
            }
        });
    }

    /** 由 MainActivity 在选择器返回后调用，异步拷贝到应用私有目录 */
    public void handlePickedFile(Uri uri) {
        if (uri == null) {
            emit("onImportDone(false," + quote("已取消") + ")");
            return;
        }
        io.execute(() -> {
            File target = modelFile();
            File temp = new File(modelsDir(), "model.gguf.part");
            try (InputStream input = activity.getContentResolver().openInputStream(uri);
                 FileOutputStream output = new FileOutputStream(temp)) {
                if (input == null) throw new Exception("无法读取所选文件");
                byte[] chunk = new byte[1 << 20];
                long copied = 0L;
                long total = -1L;
                try {
                    android.database.Cursor cursor = activity.getContentResolver().query(uri,
                            new String[]{android.provider.OpenableColumns.SIZE}, null, null, null);
                    if (cursor != null) {
                        if (cursor.moveToFirst()) total = cursor.getLong(0);
                        cursor.close();
                    }
                } catch (Exception ignored) {
                    // 拿不到大小时退化为不确定进度
                }
                int lastPercent = -1;
                int read;
                while ((read = input.read(chunk)) > 0) {
                    output.write(chunk, 0, read);
                    copied += read;
                    if (total > 0) {
                        int percent = (int) (copied * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            emit("onImportProgress(" + percent + ")");
                        }
                    }
                }
                output.flush();
            } catch (Exception error) {
                if (temp.exists()) temp.delete();
                emit("onImportDone(false," + quote("导入失败：" + error.getMessage()) + ")");
                return;
            }
            if (target.exists() && !target.delete()) {
                temp.delete();
                emit("onImportDone(false," + quote("无法覆盖已有模型") + ")");
                return;
            }
            if (!temp.renameTo(target)) {
                temp.delete();
                emit("onImportDone(false," + quote("保存模型失败，请检查存储空间") + ")");
                return;
            }
            engine.unload();
            emit("onImportDone(true," + quote("模型已导入") + ")");
        });
    }

    @JavascriptInterface
    public void deleteModel() {
        io.execute(() -> {
            engine.unload();
            File file = modelFile();
            boolean ok = !file.exists() || file.delete();
            emit("onModelState(" + quote(ok ? "模型已删除" : "删除失败") + ")");
        });
    }

    @JavascriptInterface
    public void load() {
        File file = modelFile();
        if (!file.isFile()) {
            emit("onLoadResult(false," + quote("请先导入 GGUF 模型") + ")");
            return;
        }
        int threads = Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors() - 1));
        engine.load(file.getAbsolutePath(), 4096, threads,
                progress -> emit("onLoadProgress(" + progress + ")"),
                (ok, message) -> emit("onLoadResult(" + ok + "," + quote(message) + ")"));
    }

    @JavascriptInterface
    public void unload() {
        engine.unload();
    }

    @JavascriptInterface
    public void generate(final String id, String rolesJson, String contentsJson,
                         int maxTokens, double temperature) {
        try {
            JSONArray roles = new JSONArray(rolesJson);
            JSONArray contents = new JSONArray(contentsJson);
            int count = Math.min(roles.length(), contents.length());
            String[] roleArray = new String[count];
            String[] contentArray = new String[count];
            for (int i = 0; i < count; i += 1) {
                roleArray[i] = roles.getString(i);
                contentArray[i] = contents.getString(i);
            }
            streamId = id;
            synchronized (pending) {
                pending.setLength(0);
            }
            engine.generate(roleArray, contentArray, maxTokens, (float) temperature, 0.95f, 40,
                    text -> appendToken(id, text),
                    (ok, message) -> {
                        flushTokens(true);
                        emit("onDone(" + quote(id) + "," + ok + "," + quote(message) + ")");
                    });
        } catch (Exception error) {
            emit("onDone(" + quote(id) + ",false," + quote("参数错误：" + error.getMessage()) + ")");
        }
    }

    @JavascriptInterface
    public void cancel() {
        engine.cancel();
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
        String id = streamId;
        emit("onToken(" + quote(id) + "," + quote(text) + ")");
    }

    public void destroy() {
        engine.unload();
        io.shutdownNow();
    }
}
