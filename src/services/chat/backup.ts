import { formatDate } from '../../utils/format.js'
import {
  isChatModel,
  isEffortLevel,
} from '../models.js'
import { normalizeLocation } from '../location.js'
import {
  setLocale,
  setModel,
  setLocation,
  setSearch,
  setSiderCollapsed,
  setThinking,
  setThinkingEffort,
  setThemePreference,
  setTtsVoice,
  useSettings,
} from '../settings.js'
import * as db from './db.js'
import { dumpDraftTexts, restoreDraftTexts } from './drafts.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'
import type { AppSettingsFile } from './history/format.js'
import type { ArchiveKind } from './history/format.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`
const fullBackupFileName = (date: Date) => `whalechat-backup-${formatDate(date)}.zip`

/** 列表与已加载内容构成导出快照；未打开的会话逐条读取，不填满详情缓存。 */
const readSessions = (): AsyncGenerator<Session> => {
  const { sessions, sessionCache } = useChatStore.getState()
  return (async function* () {
    for (const summary of sessions) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      if (!session) {
        throw new Error(`History session disappeared during export: ${summary.id}`)
      }
      // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
      yield { ...session, ...summary }
    }
  })()
}

/** 完整备份携带的应用设置与草稿；API Key 永不导出 */
const buildAppSettings = (): AppSettingsFile => {
  const state = useSettings.getState()
  return {
    schema: 1,
    exported_at: new Date().toISOString(),
    settings: {
      locale: state.locale,
      theme_preference: state.themePreference,
      tts_voice: state.ttsVoice,
      location: state.location,
      thinking: state.thinking,
      search: state.search,
      sider_collapsed: state.siderCollapsed,
      model: state.model,
      thinking_effort: state.thinkingEffort,
    },
    drafts: dumpDraftTexts(),
  }
}

/** 逐项校验后应用：非法值（旧版本备份或手工修改）跳过，不影响其余设置与已恢复的会话 */
const applyAppSettings = (payload: AppSettingsFile) => {
  const settings = payload.settings
  if (settings.locale === 'zh-CN' || settings.locale === 'en-US') {
    setLocale(settings.locale)
  }
  if (
    settings.theme_preference === 'light' ||
    settings.theme_preference === 'dark' ||
    settings.theme_preference === 'system'
  ) {
    setThemePreference(settings.theme_preference)
  }
  if (settings.tts_voice === 'stella' || settings.tts_voice === 'tide') {
    setTtsVoice(settings.tts_voice)
  }
  // 位置信息损坏（无法归一化）时保持本机设置
  const location = normalizeLocation(settings.location)
  if (location) {
    setLocation(location)
  }
  setThinking(settings.thinking)
  setSearch(settings.search)
  setSiderCollapsed(settings.sider_collapsed)
  if (isChatModel(settings.model)) {
    setModel(settings.model)
  }
  if (isEffortLevel(settings.thinking_effort)) {
    setThinkingEffort(settings.thinking_effort)
  }
  restoreDraftTexts(payload.drafts)
}

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 完整应用备份：会话（含 model/effort/usage）、全部附件原件、应用设置与草稿；不含 API Key。
 * 只能导入回本应用（官方 App 不识别该格式）。
 */
export const exportFullBackup = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), { full: true, appSettings: buildAppSettings() })
    return { name: fullBackupFileName(now), blob }
  })

/** 读取归档类型（校验格式与版本），供导入确认文案区分兼容格式与完整备份 */
export const checkArchiveKind = (file: File): Promise<ArchiveKind> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat } = await import('./history/importArchive.js')
    return checkArchiveFormat(file)
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与附件原件。
 * 完整备份在替换成功后应用设置与草稿（逐项校验，失败只跳过对应项）。
 */
export const importHistory = (
  file: File
): Promise<{ count: number; restoredSettings: boolean }> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    const { result, count } = await replaceHistory(() => importArchive(file))
    if (result) {
      applyAppSettings(result)
      return { count, restoredSettings: true }
    }
    return { count, restoredSettings: false }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
