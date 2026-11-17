import { navigateToExternal } from './native.js'

/**
 * 外链点击委托（仅原生平台注册）：WebView 未实现 onCreateWindow，页面里
 * `a[target="_blank"]`（Markdown 链接、来源卡、引用页等）的点击默认无效。
 * 在捕获阶段统一拦截 http(s) 外链并转交系统浏览器；blob: 等本地地址不处理。
 */
export const delegateExternalAnchors = (): (() => void) => {
  const onClick = (event: MouseEvent) => {
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
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
