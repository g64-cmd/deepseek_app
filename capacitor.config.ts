import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.g64_cmd.whalechat',
  appName: 'WhaleChat',
  webDir: 'dist',
  // androidScheme 决定 WebView 页面来源（origin = https://localhost），也就是
  // localStorage / IndexedDB 的归属；发布后不可再变，否则本地数据将不可见。
  // https 是安全上下文，录音（isSecureContext 闸门）与剪贴板 API 可用。
  server: {
    androidScheme: 'https',
  },
}

export default config
