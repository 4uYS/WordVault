package com.wordvault.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 暴露给 WebView 的原生能力桥接。
 * 前端通过 window.WordVaultNative 调用，用于单文件 WebView 环境下
 * 无法直接使用的「导出学习记录」与「本地通知」。
 */
public class WebBridge {

    public static final String CHANNEL_ID = "wordvault.reminder";
    public static final String PREFS = "wordvault.reminder.prefs";
    private static final int REQUEST_NOTIFICATIONS = 2001;

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String pendingTitle = null;
    private String pendingBody = null;

    public WebBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        Reminders.ensureChannel(activity);
    }

    private void toast(final String text) {
        main.post(() -> Toast.makeText(activity, text, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    @JavascriptInterface
    public String notificationStatus() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                return "granted";
            }
            SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return prefs.getBoolean("asked", false) ? "denied" : "default";
        }
        NotificationManager manager =
                (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean enabled = manager == null || manager.areNotificationsEnabled();
        return enabled ? "granted" : "denied";
    }

    @JavascriptInterface
    public void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                toast("通知权限已开启");
                return;
            }
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean("asked", true).apply();
            activity.requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        } else {
            toast("当前系统无需额外通知权限");
        }
    }

    @JavascriptInterface
    public void notifyNow(String title, String body) {
        if (!"granted".equals(notificationStatus())) {
            pendingTitle = title;
            pendingBody = body;
            requestNotificationPermission();
            return;
        }
        Reminders.show(activity, title, body);
    }

    @JavascriptInterface
    public void scheduleDailyReminder(String hhmm, String title, String body) {
        Reminders.schedule(activity, hhmm, title, body);
    }

    @JavascriptInterface
    public void cancelDailyReminder() {
        Reminders.cancel(activity);
    }

    /** 把备份 JSON 写成文件并通过系统分享面板导出（无需存储权限）。 */
    @JavascriptInterface
    public void exportBackup(final String filename, final String content) {
        if (content == null) {
            toast("导出内容为空");
            return;
        }
        io.execute(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "exports");
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new Exception("无法创建导出目录");
                }
                String safe = filename == null ? "wordvault-backup.json"
                        : filename.replaceAll("[^A-Za-z0-9._-]", "_");
                File file = new File(dir, safe);
                byte[] bytes = ("\uFEFF" + content).getBytes(StandardCharsets.UTF_8);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write(bytes);
                    output.flush();
                }

                Uri uri = ExportProvider.uriFor(activity, file);
                Intent send = new Intent(Intent.ACTION_SEND)
                        .setType("application/json")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "导出学习记录")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                main.post(() -> {
                    try {
                        activity.startActivity(chooser);
                    } catch (Exception error) {
                        toast("没有可用的分享应用，文件已保存在应用私有目录");
                    }
                });
            } catch (Exception error) {
                toast("导出失败：" + error.getMessage());
            }
        });
    }

    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            toast("通知权限已开启");
            if (pendingTitle != null) {
                Reminders.show(activity, pendingTitle, pendingBody);
                pendingTitle = null;
                pendingBody = null;
            }
        } else {
            toast("通知权限被拒绝，可在系统设置中开启");
        }
        if (webView != null) {
            webView.post(() -> webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('wordvault:permission-changed'))",
                    null));
        }
    }

    public void destroy() {
        io.shutdownNow();
    }
}
