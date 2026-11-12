package com.wordvault.app;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * llama.cpp 的 Java 封装。所有耗时操作都在独立线程执行，避免阻塞 WebView 主线程。
 */
public class LlmEngine {

    public interface ProgressCallback {
        void onProgress(float value);
    }

    public interface TokenSink {
        void onToken(String text);
    }

    private static native String nativeSystemInfo();

    private static native long nativeLoadModel(String path, int nCtx, int nThreads, Object progress);

    private static native void nativeFreeModel(long handle);

    private static native void nativeCancel(long handle);

    private static native boolean nativeGenerate(long handle, String[] roles, String[] contents,
                                                 int maxTokens, float temperature, float topP,
                                                 int topK, Object sink);

    private static boolean libraryLoaded = false;
    private static String loadError = "";

    static {
        try {
            System.loadLibrary("wordvault_llm");
            libraryLoaded = true;
        } catch (Throwable error) {
            loadError = error.getMessage() == null ? error.toString() : error.getMessage();
        }
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile long handle = 0L;
    private volatile boolean loading = false;

    public static boolean isLibraryLoaded() {
        return libraryLoaded;
    }

    public static String loadError() {
        return loadError;
    }

    public static String systemInfo() {
        if (!libraryLoaded) return "";
        try {
            return nativeSystemInfo();
        } catch (Throwable error) {
            return "";
        }
    }

    public boolean isLoaded() {
        return handle != 0L;
    }

    public boolean isLoading() {
        return loading;
    }

    public interface LoadResult {
        void onResult(boolean ok, String message);
    }

    public void load(final String path, final int nCtx, final int nThreads,
                     final ProgressCallback progress, final LoadResult result) {
        if (!libraryLoaded) {
            result.onResult(false, "原生库未能加载：" + loadError);
            return;
        }
        loading = true;
        executor.execute(() -> {
            try {
                if (handle != 0L) {
                    nativeFreeModel(handle);
                    handle = 0L;
                }
                long loaded = nativeLoadModel(path, nCtx, nThreads, progress);
                handle = loaded;
                loading = false;
                if (loaded == 0L) {
                    result.onResult(false, "模型加载失败，请确认文件为单文件 GGUF 且未损坏");
                } else {
                    result.onResult(true, "模型已就绪");
                }
            } catch (Throwable error) {
                loading = false;
                result.onResult(false, "模型加载异常：" + error);
            }
        });
    }

    public void generate(final String[] roles, final String[] contents, final int maxTokens,
                         final float temperature, final float topP, final int topK,
                         final TokenSink sink, final LoadResult result) {
        if (!libraryLoaded) {
            result.onResult(false, "当前设备不支持本地推理");
            return;
        }
        if (handle == 0L) {
            result.onResult(false, "模型尚未加载");
            return;
        }
        executor.execute(() -> {
            try {
                boolean ok = nativeGenerate(handle, roles, contents, maxTokens, temperature, topP,
                        topK, sink);
                result.onResult(ok, ok ? "完成" : "已中止");
            } catch (Throwable error) {
                result.onResult(false, "推理异常：" + error);
            }
        });
    }

    public void cancel() {
        long current = handle;
        if (current != 0L && libraryLoaded) {
            try {
                nativeCancel(current);
            } catch (Throwable ignored) {
                // 取消失败不影响后续流程
            }
        }
    }

    public void unload() {
        executor.execute(() -> {
            if (handle != 0L && libraryLoaded) {
                nativeFreeModel(handle);
                handle = 0L;
            }
        });
    }
}
