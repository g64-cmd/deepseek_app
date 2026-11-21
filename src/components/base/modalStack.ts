/**
 * 全屏浮层（设置弹窗、图片查看器等）的公共栈：后打开的在末尾。
 * 系统返回键 / Esc 只关闭最上层；无浮层时返回键交回退出逻辑。
 * Modal 与 ImageViewer 等自注册，backButton 只依赖本模块。
 */
export const openModals: Array<{ close: () => void }> = []

/** 关闭最上层浮层；返回是否存在浮层（存在即视为该次关闭请求已被消费） */
export const closeTopModal = (): boolean => {
  const top = openModals.at(-1)
  if (!top) {
    return false
  }
  top.close()
  return true
}
