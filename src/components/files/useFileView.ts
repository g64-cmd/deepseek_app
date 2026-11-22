import { useEffect, useState } from 'react'
import { platform } from '../../platform/index.js'
import { getFileViewType, isImage } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'
import { showToast } from '../base/toastState.js'

const createViewUrl = (blob: Blob, type: string) => {
  if (type !== 'image/svg+xml') {
    return URL.createObjectURL(blob)
  }
  // SVG 仅作为隔离的缩略图显示，保存时仍交付原文件字节。
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 草稿传 File，已发送的附件传 IndexedDB 原件 ID。 */
export const useFileView = (source: File | string, name: string) => {
  const type = getFileViewType(name)
  const [state, setState] = useState<{
    source: File | string
    type: string
    url: string | null
    blob: Blob | null
  }>()
  useEffect(() => {
    let active = true
    const original = typeof source === 'string' ? loadFile(source) : Promise.resolve(source)
    const pending = original
      .then(async (original) => {
        if (!active || !original) {
          return { url: null, blob: null }
        }
        // 预览只信任按扩展名确定的 MIME；保存仍使用独立保留的原件。
        const preview = original.slice(0, original.size, type || 'application/octet-stream')
        return { url: await createViewUrl(preview, type), blob: original }
      })
      .catch(() => ({ url: null, blob: null }))
    void pending.then((result) => {
      if (active) {
        setState({ source, type, ...result })
      }
    })
    return () => {
      active = false
      void pending.then(({ url }) => {
        if (url?.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      })
    }
  }, [source, type])

  const current = state?.source === source && state.type === type ? state : undefined
  const url = current?.url
  const blob = current?.blob
  const image = isImage(type)
  const openInTab = type === 'application/pdf' || (image && type !== 'image/svg+xml')
  const action = openInTab ? { target: '_blank', rel: 'noreferrer' } : { download: name }
  const native = platform.kind === 'native'
  const onOpen =
    native && blob
      ? () => {
          void platform.saveOrShareFile(name, blob).catch(() => {
            showToast({ key: 'fileSaveFailed', type: 'error' })
          })
        }
      : undefined
  return {
    url,
    blob,
    type,
    image,
    onOpen,
    link: !native && url ? { href: url, ...action } : undefined,
  }
}
