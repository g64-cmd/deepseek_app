package com.g64_cmd.whalechat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内本地插件需在 super.onCreate 前注册
        registerPlugin(SecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
