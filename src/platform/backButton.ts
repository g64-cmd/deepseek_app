import { App } from '@capacitor/app'
import { closeTopModal } from '../components/base/modalStack.js'
import { showToast } from '../components/base/toastState.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'

/** 根界面双击退出的确认窗口时长 */
const EXIT_CONFIRM_WINDOW = 2000
let lastExitHint = 0

/**
 * 系统返回键：与 Esc 共用弹窗栈的关闭路径——设置上的导入/删除确认框等
 * 最上层弹窗先关闭（是否真正关闭由其 onClose 的 busy 守卫决定，本次返回一律消费）；
 * 无弹窗时依次收起移动侧栏、搜索面板，全部关闭时进入双击退出确认
 * （窗口内第二次返回才退出，避免误触直接回桌面）。
 * 键盘展开时首次返回由输入法自行消费，不会进入此处。
 */
export const registerBackButton = (): (() => void) => {
  const handle = App.addListener('backButton', () => {
    if (closeTopModal()) {
      return
    }
    if (useMobileSider.getState().open) {
      closeMobileSider()
    } else if (useSearchPanel.getState().entry !== null) {
      closeSearchPanel()
    } else if (Date.now() - lastExitHint < EXIT_CONFIRM_WINDOW) {
      void App.exitApp()
    } else {
      lastExitHint = Date.now()
      showToast({ key: 'exitConfirmToast' })
    }
  })
  return () => {
    void handle.then((listener) => listener.remove())
  }
}
