package com.vio.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "AudioRoute",
    permissions = {
        @Permission(alias = AudioRoutePlugin.BLUETOOTH_ALIAS, strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class AudioRoutePlugin extends Plugin {
    static final String BLUETOOTH_ALIAS = "bluetooth";
    private static final String EVENT_ROUTE_CHANGED = "routeChanged";
    private static final String KIND_BLUETOOTH = "bluetooth";
    private static final String KIND_NONE = "none";
    private static final int DEFAULT_TIMEOUT_MS = 3000;
    private static final long POLL_INTERVAL_MS = 200;
    private static final long RECONNECT_PAUSE_MS = 800;

    private AudioManager audioManager;
    private AudioDeviceCallback deviceCallback;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        deviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                notifyListeners(EVENT_ROUTE_CHANGED, currentRoute());
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                notifyListeners(EVENT_ROUTE_CHANGED, currentRoute());
            }
        };
        audioManager.registerAudioDeviceCallback(deviceCallback, null);
    }

    @Override
    protected void handleOnDestroy() {
        audioManager.unregisterAudioDeviceCallback(deviceCallback);
    }

    @PluginMethod
    public void getRoute(PluginCall call) {
        call.resolve(currentRoute());
    }

    /* ---------- Мікрофон Bluetooth-гарнітури ---------- */

    // Вмикає мікрофон гарнітури й чекає підтвердження системи до timeoutMs; force спершу вимикає його, щоб підключити заново
    @PluginMethod
    public void connectHeadsetMic(PluginCall call) {
        boolean needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState(BLUETOOTH_ALIAS) != PermissionState.GRANTED;
        if (needsPermission) {
            requestPermissionForAlias(BLUETOOTH_ALIAS, call, "onBluetoothPermissionResult");
            return;
        }
        runConnect(call);
    }

    @PermissionCallback
    private void onBluetoothPermissionResult(PluginCall call) {
        if (getPermissionState(BLUETOOTH_ALIAS) != PermissionState.GRANTED) {
            call.resolve(connectResult(false, 0, "немає дозволу на Bluetooth (BLUETOOTH_CONNECT)"));
            return;
        }
        runConnect(call);
    }

    @PluginMethod
    public void disconnectHeadsetMic(PluginCall call) {
        releaseRouting();
        call.resolve();
    }

    private void runConnect(PluginCall call) {
        boolean isForced = Boolean.TRUE.equals(call.getBoolean("force", false));
        int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        new Thread(() -> {
            long startedAt = SystemClock.elapsedRealtime();
            try {
                if (isForced) {
                    releaseRouting();
                    Thread.sleep(RECONNECT_PAUSE_MS);
                }
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                long deadline = startedAt + timeoutMs;
                boolean isConnected = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? connectModern(deadline)
                    : connectLegacy(deadline);
                long waited = SystemClock.elapsedRealtime() - startedAt;
                call.resolve(connectResult(isConnected, waited, isConnected ? "" : "гарнітура не підтвердила підключення мікрофона"));
            } catch (InterruptedException err) {
                Thread.currentThread().interrupt();
                call.reject("Підключення мікрофона гарнітури перервано", err);
            } catch (RuntimeException err) {
                call.reject("Не вдалося підключити мікрофон гарнітури: " + err.getMessage(), err);
            }
        }, "vio-headset-mic").start();
    }

    private JSObject connectResult(boolean isConnected, long waitedMs, String reason) {
        JSObject result = new JSObject();
        result.put("connected", isConnected);
        result.put("waitedMs", waitedMs);
        result.put("reason", reason);
        result.put("android", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        result.put("devices", describeDevices());
        return result;
    }

    // Пристрої зв'язку (Android 12+) або входи (старіші версії) з типами — для діагностики підключення гарнітури
    private String describeDevices() {
        List<AudioDeviceInfo> devices = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? audioManager.getAvailableCommunicationDevices()
            : java.util.Arrays.asList(audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS));
        if (devices.isEmpty()) return "список порожній";
        StringBuilder text = new StringBuilder();
        for (AudioDeviceInfo device : devices) {
            if (text.length() > 0) text.append("; ");
            text.append(typeName(device.getType())).append(" «").append(device.getProductName()).append('»');
        }
        return text.toString();
    }

    private String typeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "вбудований мікрофон";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "розмовний динамік";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "динамік";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "BLUETOOTH_SCO";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "BLUETOOTH_A2DP";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "дротова гарнітура";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "дротові навушники";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB-гарнітура";
            case AudioDeviceInfo.TYPE_TELEPHONY: return "телефонія";
            default:
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) return "BLE_HEADSET";
                return "тип " + type;
        }
    }

    // Android 12+: обираємо пристрій зв'язку «гарнітура» і чекаємо, поки система визнає його активним, а вхід гарнітури з'явиться
    private boolean connectModern(long deadline) throws InterruptedException {
        while (SystemClock.elapsedRealtime() < deadline) {
            AudioDeviceInfo headset = findCommunicationHeadset();
            if (headset != null && isHeadsetActive(headset)) return true;
            if (headset != null) audioManager.setCommunicationDevice(headset);
            Thread.sleep(POLL_INTERVAL_MS);
        }
        return false;
    }

    private AudioDeviceInfo findCommunicationHeadset() {
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo device : devices) {
            if (isHeadsetCommunicationType(device.getType())) return device;
        }
        return null;
    }

    private boolean isHeadsetActive(AudioDeviceInfo headset) {
        AudioDeviceInfo active = audioManager.getCommunicationDevice();
        boolean isSelected = active != null && active.getId() == headset.getId();
        return isSelected && hasHeadsetInput();
    }

    private boolean hasHeadsetInput() {
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            if (isHeadsetCommunicationType(device.getType())) return true;
        }
        return false;
    }

    // Android 11 і старіші: класичний SCO-канал, підтвердження — системна подія SCO_AUDIO_STATE_CONNECTED
    @SuppressWarnings("deprecation")
    private boolean connectLegacy(long deadline) throws InterruptedException {
        CountDownLatch connected = new CountDownLatch(1);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR);
                if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) connected.countDown();
            }
        };
        Context context = getContext();
        Intent sticky = context.registerReceiver(receiver, new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED));
        try {
            boolean isAlreadyConnected = sticky != null && sticky.getIntExtra(
                AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR) == AudioManager.SCO_AUDIO_STATE_CONNECTED;
            if (isAlreadyConnected) return true;
            audioManager.startBluetoothSco();
            audioManager.setBluetoothScoOn(true);
            long remaining = Math.max(deadline - SystemClock.elapsedRealtime(), 0);
            return connected.await(remaining, TimeUnit.MILLISECONDS);
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @SuppressWarnings("deprecation")
    private void releaseRouting() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice();
        } else {
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
        }
        audioManager.setMode(AudioManager.MODE_NORMAL);
    }

    private boolean isHeadsetCommunicationType(int type) {
        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET;
    }

    /* ---------- Маршрут ---------- */

    private JSObject currentRoute() {
        boolean isBluetooth = false;
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (isBluetoothType(device.getType())) {
                isBluetooth = true;
                break;
            }
        }
        JSObject route = new JSObject();
        route.put("kind", isBluetooth ? KIND_BLUETOOTH : KIND_NONE);
        return route;
    }

    private boolean isBluetoothType(int type) {
        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
            return true;
        }
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLE_SPEAKER);
    }
}
