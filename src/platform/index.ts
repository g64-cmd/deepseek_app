import { Capacitor } from '@capacitor/core'

export type PlatformKind = 'web' | 'native'

/** 保存/分享结果：ok=false 且 cancelled=true 表示用户主动取消 */
export interface SaveFileResult {
  ok: boolean
  cancelled?: boolean
}

/**
 * 平台能力适配层：Web 与 Android（Capacitor）差异的唯一收口。
 *
 * 传输层（fetch/SSE/上传）暂不抽象——先验证 WebView 流式实现，若确需原生传输
 * （见 docs/android-improvement-proposal.md 4.1 节）再在此扩展可替换接口。
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind
  /** 在外部打开 http(s) 链接：Web 新标签页，Android 系统浏览器 */
  openExternal(url: string): Promise<void>
  /** 把二进制内容交给用户：Web 触发浏览器下载，Android 拉起系统分享面板 */
  saveOrShareFile(name: string, blob: Blob): Promise<SaveFileResult>
}

const isNative = Capacitor.isNativePlatform()

// 原生实现按需加载，Web 构建不打包插件代码
let adapterPromise: Promise<PlatformAdapter> | null = null

const ensureAdapter = (): Promise<PlatformAdapter> => {
  adapterPromise ??= isNative
    ? import('./native.js').then((module) => module.nativePlatform)
    : import('./web.js').then((module) => module.webPlatform)
  return adapterPromise
}

export const platform: PlatformAdapter = {
  get kind(): PlatformKind {
    return isNative ? 'native' : 'web'
  },
  openExternal: (url) => ensureAdapter().then((adapter) => adapter.openExternal(url)),
  saveOrShareFile: (name, blob) =>
    ensureAdapter().then((adapter) => adapter.saveOrShareFile(name, blob)),
}

/**
 * 应用启动时注册原生平台行为（系统返回键、外链点击委托）；Web 下为 no-op。
 * 返回清理函数供组件卸载时移除监听。
 */
export const setupPlatform = (): (() => void) | undefined => {
  if (!isNative) {
    return undefined
  }
  const cleanups: Array<() => void> = []
  let cancelled = false
  void Promise.all([import('./backButton.js'), import('./externalLinks.js'), import('./native.js')]).then(
    ([backButton, externalLinks, native]) => {
      if (cancelled) {
        return
      }
      cleanups.push(backButton.registerBackButton(), externalLinks.delegateExternalAnchors())
      // 清理历次导出残留在 cache 的备份文件（不阻塞启动）
      void native.cleanupExportCache()
    }
  )
  return () => {
    cancelled = true
    for (const cleanup of cleanups) {
      cleanup()
    }
  }
}
