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

/** 分块大小与单次写入阈值（字节）：小文件一次写完，大文件分块追加，压低 base64 过桥内存峰值 */
const WRITE_CHUNK = 4 * 1024 * 1024
const SINGLE_WRITE_LIMIT = 8 * 1024 * 1024

/** 写入过 cache 的导出/分享文件清单：启动时按清单清理（localStorage 容错） */
const CACHE_REGISTRY_KEY = 'chat-demo:export-cache'

const readCacheRegistry = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_REGISTRY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

const writeCacheRegistry = (names: string[]) => {
  try {
    localStorage.setItem(CACHE_REGISTRY_KEY, JSON.stringify(names))
  } catch {
    // 存储不可用时退回按前缀清理
  }
}

/** 分块写入 cache 目录：首块 writeFile、后续 appendFile（不传 encoding 按二进制追加） */
const writeBlobToCache = async (name: string, blob: Blob): Promise<string> => {
  const uri =
    blob.size <= SINGLE_WRITE_LIMIT
      ? (
          await Filesystem.writeFile({
            path: name,
            data: await blobToBase64(blob),
            directory: Directory.Cache,
          })
        ).uri
      : await writeBlobChunked(name, blob)
  writeCacheRegistry([...new Set([...readCacheRegistry(), name])])
  return uri
}

const writeBlobChunked = async (name: string, blob: Blob): Promise<string> => {
  let uri = ''
  for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK) {
    const chunk = blob.slice(offset, offset + WRITE_CHUNK)
    const data = await blobToBase64(chunk)
    if (offset === 0) {
      uri = (await Filesystem.writeFile({ path: name, data, directory: Directory.Cache })).uri
    } else {
      await Filesystem.appendFile({ path: name, data, directory: Directory.Cache })
    }
  }
  return uri
}

/**
 * 启动时清理历次导出/分享残留在 cache 目录的文件：优先按写入清单删（文件名不固定的
 * 附件分享也覆盖），另按历史导出前缀兜底（旧版本写入、清单丢失的残留）。
 * 不在分享结束后立刻删：「保存到文件」的 SAF 读取完成时机不可知，立即删除可能
 * 截断保存；启动时上一次会话的文件必然不再被引用。全部容错，失败不影响使用。
 */
export const cleanupExportCache = async (): Promise<void> => {
  const targets = new Set(readCacheRegistry())
  try {
    const { files } = await Filesystem.readdir({ path: '', directory: Directory.Cache })
    for (const file of files) {
      if (/^(deepseek_data-|whalechat-backup-)/.test(file.name)) {
        targets.add(file.name)
      }
    }
  } catch {
    // cache 目录不可读时仍尝试按清单删除
  }
  for (const name of targets) {
    await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {})
  }
  writeCacheRegistry([])
}

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
    const uri = await writeBlobToCache(name, blob)
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
