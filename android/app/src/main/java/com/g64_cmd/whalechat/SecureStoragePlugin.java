package com.g64_cmd.whalechat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API Key 的加密存储：AES-256-GCM，密钥保存在 AndroidKeyStore（不可导出），
 * 密文与 IV 落在应用私有 SharedPreferences。value 为 null 或空时清除记录。
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {

    private static final String PREFS_NAME = "secure_storage";
    private static final String PREF_KEY = "api_key";
    private static final String KEY_ALIAS = "whalechat_api_key";

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        try {
            Context context = getContext();
            if (value == null || value.isEmpty()) {
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit().remove(PREF_KEY).apply();
                call.resolve();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getKey());
            String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                    + ":" + Base64.encodeToString(
                            cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString(PREF_KEY, stored).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("secure storage write failed", error);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String stored = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_KEY, null);
            if (stored != null) {
                String[] parts = stored.split(":");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, getKey(),
                        new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                result.put("value", new String(
                        cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
                        StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) {
            // 密文损坏或 Keystore 密钥失效（如异常恢复）：清除记录并按无值处理，由用户重新输入
            getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().remove(PREF_KEY).apply();
            call.resolve(result);
        }
    }

    /** 首次使用时在 AndroidKeyStore 生成不可导出的 AES-256 密钥 */
    private SecretKey getKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
