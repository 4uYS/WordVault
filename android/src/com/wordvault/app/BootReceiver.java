package com.wordvault.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机或应用更新后恢复每日提醒。只接收系统受保护广播。 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Reminders.restore(context);
        }
    }
}
