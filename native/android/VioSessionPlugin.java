package com.vio.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "VioSession",
    permissions = {
        @Permission(alias = VioSessionPlugin.NOTIFICATIONS_ALIAS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class VioSessionPlugin extends Plugin {
    static final String NOTIFICATIONS_ALIAS = "notifications";

    // Мікрофонний foreground-сервіс вимагає вже виданого RECORD_AUDIO, тож викликати start() слід після відкриття мікрофона
    @PluginMethod
    public void start(PluginCall call) {
        boolean isNotificationAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState(NOTIFICATIONS_ALIAS) == PermissionState.GRANTED;
        if (isNotificationAllowed) {
            launchService(call);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS_ALIAS, call, "onNotificationsResult");
    }

    // Відмова в сповіщеннях не заважає роботі сервісу: Android лише приховує його сповіщення
    @PermissionCallback
    private void onNotificationsResult(PluginCall call) {
        launchService(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, VioForegroundService.class));
        call.resolve();
    }

    private void launchService(PluginCall call) {
        Context context = getContext();
        boolean hasMicrophone = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        if (!hasMicrophone) {
            call.reject("Немає дозволу на мікрофон (RECORD_AUDIO)");
            return;
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(context, VioForegroundService.class));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Не вдалося запустити фоновий сервіс: " + err.getMessage(), err);
        }
    }
}
