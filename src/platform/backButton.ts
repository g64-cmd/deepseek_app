import { App } from '@capacitor/app'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { closeSettings, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'

/**
 * 系统返回键：按「设置弹窗 → 移动侧栏 → 搜索面板」的顺序收起浮层，
 * 全部关闭时退出应用。键盘展开时首次返回由输入法自行消费，不会进入此处。
 */
export const registerBackButton = (): (() => void) => {
  const handle = App.addListener('backButton', () => {
    if (useSettingsDialog.getState().open) {
      closeSettings()
    } else if (useMobileSider.getState().open) {
      closeMobileSider()
    } else if (useSearchPanel.getState().entry !== null) {
      closeSearchPanel()
    } else {
      void App.exitApp()
    }
  })
  return () => {
    void handle.then((listener) => listener.remove())
  }
}
