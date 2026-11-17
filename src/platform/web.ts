import type { PlatformAdapter, SaveFileResult } from './index.js'

/** 浏览器默认实现：与接入平台适配层之前的原行为完全一致 */
export const webPlatform: PlatformAdapter = {
  kind: 'web',
  async openExternal(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  async saveOrShareFile(name: string, blob: Blob): Promise<SaveFileResult> {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true }
  },
}
