package com.stitch.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.stitch.mobile.device.StitchDevicePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(StitchDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
