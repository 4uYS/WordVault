package com.wordvault.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

/** 通知渠道、即时通知与每日定时提醒的统一入口。 */
final class Reminders {

    static final String ACTION_REMIND = "com.wordvault.app.REMIND";
    static final int ALARM_REQUEST = 1001;
    static final int NOTIFICATION_ID = 1001;

    private Reminders() {
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                WebBridge.CHANNEL_ID, "每日学习提醒", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("WordVault 的复习提醒");
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }

    static Notification build(Context context, String title, String body) {
        ensureChannel(context);
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(
                context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, WebBridge.CHANNEL_ID)
                : new Notification.Builder(context);
        return builder
                .setSmallIcon(R.drawable.ic_stat_wordvault)
                .setContentTitle(title == null ? "WordVault" : title)
                .setContentText(body == null ? "该复习今天的单词了" : body)
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();
    }

    static void show(Context context, String title, String body) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (!manager.areNotificationsEnabled()) return;
        try {
            manager.notify(NOTIFICATION_ID, build(context, title, body));
        } catch (SecurityException ignored) {
            // 没有通知权限时静默失败，前端会引导用户授权
        }
    }

    static void schedule(Context context, String hhmm, String title, String body) {
        int hour = 20;
        int minute = 0;
        try {
            String[] parts = String.valueOf(hhmm).split(":");
            hour = Integer.parseInt(parts[0]);
            minute = Integer.parseInt(parts[1]);
        } catch (Exception ignored) {
            // 使用默认时间
        }

        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, hour);
        next.set(Calendar.MINUTE, minute);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) {
            next.add(Calendar.DAY_OF_YEAR, 1);
        }

        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;

        Intent intent = new Intent(context, ReminderReceiver.class)
                .setAction(ACTION_REMIND)
                .putExtra("title", title)
                .putExtra("body", body);
        PendingIntent pending = PendingIntent.getBroadcast(
                context, ALARM_REQUEST, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 不申请精确闹钟权限，允许系统做省电对齐
        manager.setInexactRepeating(
                AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), AlarmManager.INTERVAL_DAY, pending);

        context.getSharedPreferences(WebBridge.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean("enabled", true)
                .putString("time", String.format("%02d:%02d", hour, minute))
                .putString("title", title)
                .putString("body", body)
                .apply();
    }

    static void cancel(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, ReminderReceiver.class).setAction(ACTION_REMIND);
        PendingIntent pending = PendingIntent.getBroadcast(
                context, ALARM_REQUEST, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (manager != null) manager.cancel(pending);
        context.getSharedPreferences(WebBridge.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean("enabled", false).apply();
    }

    /** 开机或应用升级后恢复每日提醒。 */
    static void restore(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(WebBridge.PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean("enabled", false)) return;
        schedule(
                context,
                prefs.getString("time", "20:00"),
                prefs.getString("title", "WordVault 每日学习提醒"),
                prefs.getString("body", "该复习今天的单词了"));
    }
}
