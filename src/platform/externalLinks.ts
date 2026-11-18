import { navigateToExternal } from './native.js'

/**
 * 外链点击委托（仅原生平台注册）：WebView 未实现 onCreateWindow，页面里
 * `a[target="_blank"]`（Markdown 链接、来源卡、引用页等）的点击默认无效。
 *
 * 在冒泡阶段处理：先让引用角标等嵌套在链接内的子组件处理自身点击——它们
 * 会 preventDefault / stopPropagation，已取消的事件不再委托，避免一次点击
 * 打开两个地址。http(s) 之外（如 blob:）不处理。
 */
export const delegateExternalAnchors = (): (() => void) => {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) {
      return
    }
    if (!(event.target instanceof Node)) {
      return
    }
    const element = event.target instanceof Element ? event.target : event.target.parentElement
    const anchor = element?.closest('a[target="_blank"]')
    if (!anchor) {
      return
    }
    const href = anchor.getAttribute('href')
    if (href && /^https?:/i.test(href)) {
      event.preventDefault()
      navigateToExternal(href)
    }
  }
  document.addEventListener('click', onClick, false)
  return () => document.removeEventListener('click', onClick, false)
}
