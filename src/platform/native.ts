import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { PlatformAdapter, SaveFileResult } from './index.js'

/** Blob → 纯 base64（不含 data: 前缀）；Filesystem.writeFile 以 base64 承载二进制 */
const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const result = reader.result
      resolve(typeof result === 'string' ? result.slice(result.indexOf(',') + 1) : '')
    }
    reader.readAsDataURL(blob)
  })

/**
 * 通过隐藏锚点触发导航：外域 http(s) 由 Capacitor 的 shouldOverrideUrlLoading
 * 转交系统浏览器（Bridge.launchIntent）。WebView 未实现 onCreateWindow，
 * 因此 window.open / target=_blank 在原生侧无效。
 */
export const navigateToExternal = (url: string) => {
  if (!/^https?:/i.test(url)) {
    return
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noreferrer'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Android（Capacitor）实现：
 * - blob: 等非 http(s) 地址无法跨应用打开，openExternal 直接忽略
 *   （本地附件的外部查看留待后续阶段，见 docs/android-phase-a-verification.md）。
 * - 导出经 cache 目录 + 系统分享面板（可「保存到文件」）；blob 需 base64 过桥，
 *   大体积历史的内存峰值已列入阶段 A 验证项。
 */
export const nativePlatform: PlatformAdapter = {
  kind: 'native',
  async openExternal(url: string) {
    navigateToExternal(url)
  },
  async saveOrShareFile(name: string, blob: Blob): Promise<SaveFileResult> {
    const base64 = await blobToBase64(blob)
    const { uri } = await Filesystem.writeFile({
      path: name,
      data: base64,
      directory: Directory.Cache,
    })
    try {
      await Share.share({ title: name, dialogTitle: name, url: uri })
    } catch (error) {
      // 用户收起分享面板时插件以 "Share canceled" 拒绝，视为取消而非失败
      if (error instanceof Error && /cancel/i.test(error.message)) {
        return { ok: false, cancelled: true }
      }
      throw error
    }
    return { ok: true }
  },
}
