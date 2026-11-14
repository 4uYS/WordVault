package com.wordvault.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 接收每日提醒闹钟。 */
public class ReminderReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Reminders.ACTION_REMIND.equals(action)) {
            String title = intent.getStringExtra("title");
            String body = intent.getStringExtra("body");
            Reminders.show(context, title, body);
        }
    }
}
