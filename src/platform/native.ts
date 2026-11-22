import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { createId } from '../utils/id.js'
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
const SHARE_CACHE_DIR = 'whalechat-share'
/** 本次进程创建的文件可能仍被接收应用读取，启动清理只处理此前进程的文件。 */
const currentExports = new Set<string>()

const isCacheName = (name: string) =>
  name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !name.includes('\0')

const isShareDirectory = (path: string) =>
  path.startsWith(`${SHARE_CACHE_DIR}/`) &&
  /^[a-zA-Z0-9-]+$/.test(path.slice(SHARE_CACHE_DIR.length + 1))

const isCacheEntry = (path: string) =>
  (isCacheName(path) && path !== SHARE_CACHE_DIR) || isShareDirectory(path)

/** 展示文件名不承担缓存身份；剥除路径，防止附件名称逃出本次分享目录。 */
const cacheFileName = (name: string) => {
  const leaf = [...(name.split(/[\\/]/).at(-1) ?? '')]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .replace(/[<>:"|?*]/g, '_')
  return isCacheName(leaf) ? leaf : 'attachment'
}

const readCacheRegistry = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_REGISTRY_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string' && isCacheEntry(name))
      : []
  } catch {
    return []
  }
}

const writeCacheRegistry = (names: string[]) => {
  try {
    localStorage.setItem(CACHE_REGISTRY_KEY, JSON.stringify(names))
  } catch {
    // 存储不可用时退回专用目录与旧版导出前缀清理。
  }
}

/** 成功删除或已不存在才确认清理；其他失败保留登记供下次启动重试。 */
const removeCacheEntry = async (path: string): Promise<boolean> => {
  try {
    if (isShareDirectory(path)) {
      await Filesystem.rmdir({ path, directory: Directory.Cache, recursive: true })
    } else {
      await Filesystem.deleteFile({ path, directory: Directory.Cache })
    }
    return true
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'OS-PLUG-FILE-0008'
    )
  }
}

const forgetCacheEntries = (removed: Set<string>, retained: Iterable<string> = []) => {
  // 清理期间可能有新分享登记，只移除已经确认删除的对象，不覆盖整个清单。
  writeCacheRegistry([
    ...new Set([...readCacheRegistry().filter((path) => !removed.has(path)), ...retained]),
  ])
}

/** 分块写入 cache 目录：首块 writeFile、后续 appendFile（不传 encoding 按二进制追加） */
const writeBlobToCache = async (name: string, blob: Blob): Promise<string> => {
  const directory = `${SHARE_CACHE_DIR}/${createId()}`
  const path = `${directory}/${cacheFileName(name)}`
  currentExports.add(directory)
  // 首次写入前登记：即使进程在后续分块写入中被杀，也能在下一次启动清理。
  writeCacheRegistry([...new Set([...readCacheRegistry(), directory])])
  try {
    await Filesystem.mkdir({ path: directory, directory: Directory.Cache, recursive: true })
    return blob.size <= SINGLE_WRITE_LIMIT
      ? (
          await Filesystem.writeFile({
            path,
            data: await blobToBase64(blob),
            directory: Directory.Cache,
          })
        ).uri
      : await writeBlobChunked(path, blob)
  } catch (error) {
    if (await removeCacheEntry(directory)) {
      forgetCacheEntries(new Set([directory]))
    }
    currentExports.delete(directory)
    throw error
  }
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
 * 截断保存。本进程创建的对象保持可用，避免异步启动清理误删刚分享的文件。
 * 专用目录兜底覆盖清单损坏/不可写，旧版文件仍按清单与备份前缀清理。
 */
export const cleanupExportCache = async (): Promise<void> => {
  const targets = new Set(readCacheRegistry())
  try {
    const { files } = await Filesystem.readdir({ path: '', directory: Directory.Cache })
    for (const file of files) {
      if (/^(deepseek_data-|whalechat-backup-)/.test(file.name)) {
        if (isCacheName(file.name) && file.type !== 'directory') {
          targets.add(file.name)
        }
      }
    }
  } catch {
    // cache 目录不可读时仍尝试按清单删除
  }
  try {
    const { files } = await Filesystem.readdir({
      path: SHARE_CACHE_DIR,
      directory: Directory.Cache,
    })
    for (const file of files) {
      const path = `${SHARE_CACHE_DIR}/${file.name}`
      if (file.type === 'directory' && isShareDirectory(path)) {
        targets.add(path)
      }
    }
  } catch {
    // 目录尚未建立或不可读时仍按清单清理。
  }
  const removed = new Set<string>()
  const retained = new Set<string>()
  for (const path of targets) {
    if (currentExports.has(path)) {
      continue
    }
    if (await removeCacheEntry(path)) {
      removed.add(path)
    } else {
      retained.add(path)
    }
  }
  forgetCacheEntries(removed, retained)
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
