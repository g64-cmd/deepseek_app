import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel, EffortLevel } from './api/types.js'
import {
  readSecureApiKey,
  secureCredentialsAvailable,
  writeSecureApiKey,
} from '../platform/secureStorage.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { DEFAULT_EFFORT, DEFAULT_MODEL, isChatModel, isEffortLevel } from './models.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、思考强度、模型、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 聊天模型；每条回复单独快照，这里只影响新回复 */
  model: ChatModel
  /** 思考强度；仅深度思考开启时随请求携带 */
  thinkingEffort: EffortLevel
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  model: 'chat-demo:model',
  thinkingEffort: 'chat-demo:thinking-effort',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 保存值非法（旧版本或手改）时回退默认模型 */
const initialModel = (): ChatModel => {
  const saved = read(KEYS.model)
  return saved !== null && isChatModel(saved) ? saved : DEFAULT_MODEL
}

const initialThinkingEffort = (): EffortLevel => {
  const saved = read(KEYS.thinkingEffort)
  return saved !== null && isEffortLevel(saved) ? saved : DEFAULT_EFFORT
}

export const useSettings = create<Settings>(() => ({
  // 原生侧 API Key 存于 Keystore 加密存储（见 hydrateApiKey），Web 侧仍读 localStorage
  apiKey: secureCredentialsAvailable ? null : read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  model: initialModel(),
  thinkingEffort: initialThinkingEffort(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  if (secureCredentialsAvailable) {
    // 写入失败时与 localStorage 同策略：只在内存生效，重启后需重新输入
    void writeSecureApiKey(apiKey).catch(() => {})
  } else {
    write(KEYS.apiKey, apiKey)
  }
  useSettings.setState({ apiKey })
}

/** 启动时把 Keystore 中的 API Key 注入内存；首次升级时迁移 localStorage 明文并清除。须在渲染前完成。 */
export const hydrateApiKey = async (): Promise<void> => {
  if (!secureCredentialsAvailable) {
    return
  }
  try {
    let value = await readSecureApiKey()
    if (value === null) {
      const legacy = read(KEYS.apiKey)
      if (legacy) {
        await writeSecureApiKey(legacy)
        write(KEYS.apiKey, null)
        value = legacy
      }
    }
    if (value) {
      useSettings.setState({ apiKey: value })
    }
  } catch {
    // 读取失败按无 Key 处理，由用户重新输入
  }
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setThinkingEffort = (thinkingEffort: EffortLevel) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}
