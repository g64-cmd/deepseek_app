import { Capacitor } from '@capacitor/core'

/** android/ 内的 SecureStorage 插件（Keystore AES-GCM，MainActivity 注册） */
interface SecureStorage {
  /** value 为 null 时清除记录 */
  set(options: { value: string | null }): Promise<void>
  get(): Promise<{ value?: string | null }>
}

const SecureStorage = Capacitor.registerPlugin<SecureStorage>('SecureStorage')

/** 仅 Android 原生平台有 Keystore 加密存储；Web 侧恒为 false */
export const secureCredentialsAvailable = Capacitor.isNativePlatform()

export const readSecureApiKey = async (): Promise<string | null> => {
  if (!secureCredentialsAvailable) {
    return null
  }
  return (await SecureStorage.get()).value ?? null
}

export const writeSecureApiKey = (value: string | null): Promise<void> => {
  if (!secureCredentialsAvailable) {
    return Promise.resolve()
  }
  return SecureStorage.set({ value })
}
