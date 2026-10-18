package com.vio.app;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {
    private static final String EVENT_ROUTE_CHANGED = "routeChanged";
    private static final String KIND_BLUETOOTH = "bluetooth";
    private static final String KIND_SPEAKER = "speaker";

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

    private JSObject currentRoute() {
        boolean isBluetooth = false;
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (isBluetoothType(device.getType())) {
                isBluetooth = true;
                break;
            }
        }
        JSObject route = new JSObject();
        route.put("kind", isBluetooth ? KIND_BLUETOOTH : KIND_SPEAKER);
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
