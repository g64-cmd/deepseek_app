import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 账户（余额与用量）/ 数据管理 */
export type SettingsSection = 'general' | 'account' | 'data'

/** section 是可见分组的唯一状态；tab 点击与程序化导航都写入这一份状态。 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

export const setSettingsSection = (section: SettingsSection) =>
  useSettingsDialog.setState({ section })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
