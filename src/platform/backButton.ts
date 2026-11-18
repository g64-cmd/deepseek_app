import { App } from '@capacitor/app'
import { closeTopModal } from '../components/base/Modal.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'

/**
 * 系统返回键：与 Esc 共用弹窗栈的关闭路径——设置上的导入/删除确认框等
 * 最上层弹窗先关闭（是否真正关闭由其 onClose 的 busy 守卫决定，本次返回一律消费）；
 * 无弹窗时依次收起移动侧栏、搜索面板，全部关闭时退出应用。
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
    } else {
      void App.exitApp()
    }
  })
  return () => {
    void handle.then((listener) => listener.remove())
  }
}
