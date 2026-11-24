import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { isUploadImageOversized } from '../utils/resizeUploadImage.js'
import { uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose } from './api/types.js'
import { loadFile } from './chat/db.js'
import type { FileAttachment } from './chat/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
export const MAX_DOCUMENT_SIZE_MB = 100
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档（解析成功按页计费）；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 是否为按页计费的版面解析文档；发送前的计费说明只针对这类文件 */
export const isLayoutDocument = (name: string) => LAYOUT_RECOGNITION_EXTS.has(getFileExt(name))

/** 旧附件没有 purpose 时的兼容缺省：图片不传，版面文档图文混排，其余 user_data。 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 版面解析 purpose：重新上传意味着再次按页计费 */
export const isParseBilledPurpose = (purpose: FilePurpose | null): boolean =>
  purpose === 'text_recognition' || purpose === 'rich_layout_recognition'

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : isImage(resolveMimeType(file))
      ? MAX_SIZE_MB
      : MAX_DOCUMENT_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  if (classifyApiError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/zh-cn/guides/files_api/#删除文件'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  purpose: FilePurpose | null,
  signal: AbortSignal,
  onStart: () => void
) =>
  new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    queue.push(async () => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      onStart()
      try {
        const body = file instanceof File ? file : new File([file], name, { type: file.type })
        resolve((await uploadFile(apiKey, body, purpose, signal)).id)
      } catch (error) {
        reject(error)
      }
    })
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

type PendingUpload = {
  promise: Promise<string>
  controller: AbortController
  state: { started: boolean; consumers: Set<symbol> }
}
const pending = new Map<string, PendingUpload>()

/** 一个使用方停止只释放自己的使用权；已开始的上传继续保存结果。 */
const retainUpload = (task: PendingUpload, signal?: AbortSignal): Promise<string> => {
  signal?.throwIfAborted()
  const consumer = Symbol()
  task.state.consumers.add(consumer)
  const release = () => {
    task.state.consumers.delete(consumer)
    if (!task.state.started && task.state.consumers.size === 0) {
      task.controller.abort(new DOMException('No active upload consumers', 'AbortError'))
    }
  }
  signal?.addEventListener('abort', release, { once: true })
  return task.promise.finally(() => {
    signal?.removeEventListener('abort', release)
    release()
  })
}

export const hasPendingUpload = (id: string): boolean => {
  const task = pending.get(id)
  return !!task && !task.controller.signal.aborted
}

/** 只复用已获授权的现有任务；任务已取消或不存在时不创建新的上传。 */
export const reuseUpload = (id: string, signal: AbortSignal): Promise<string> | undefined => {
  const task = pending.get(id)
  return task && !task.controller.signal.aborted ? retainUpload(task, signal) : undefined
}

/**
 * 开始或复用上传；signal 释放本次使用权，无使用方的排队任务不再启动。
 * 已开始的上传继续返回结果；草稿未传 signal 时持有使用权直到完成或显式 cancelUpload。
 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<string> => {
  signal?.throwIfAborted()
  const current = pending.get(id)
  if (current && !current.controller.signal.aborted) {
    return retainUpload(current, signal)
  }
  const controller = new AbortController()
  const state = { started: false, consumers: new Set<symbol>() }
  const isCurrent = () => pending.get(id)?.controller === controller
  // 先注册任务和使用方再调度，队列启动时才能正确判定它是否仍被需要。
  const promise = enqueueUpload(apiKey, blob, name, purpose, controller.signal, () => {
    state.started = true
  })
    .then((serverId) => {
      if (isCurrent()) {
        setTask(id, { status: 'done', serverId })
      }
      return serverId
    })
    .catch((error: unknown) => {
      if (!isCurrent()) {
        throw error
      } else if (controller.signal.aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => {
      // 旧任务取消后可能已创建同 ID 的新任务，旧回调不能清掉新任务。
      if (isCurrent()) {
        pending.delete(id)
      }
    })
  const task = { promise, controller, state }
  pending.set(id, task)
  const result = retainUpload(task, signal)
  setTask(id, { status: 'uploading' })
  next()
  return result
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  pending.delete(id)
  setTask(id, null)
}

/** 检查旧图片的 file_id。超限返回 null 以触发补传，无法读取原件时保留原 ID。 */
export const checkImageFileIds = async (files: FileAttachment[], signal: AbortSignal) => {
  const checked = new Map<string, string | null>()
  for (const file of files) {
    if (!file.isImage || !file.serverId || file.imageSizeChecked || checked.has(file.id)) {
      continue
    }
    signal.throwIfAborted()
    const oversized = await loadFile(file.id)
      .then((blob) => blob && isUploadImageOversized(blob))
      .catch(() => undefined)
    if (oversized === undefined) {
      continue
    }
    signal.throwIfAborted()
    const task = useUploads.getState().tasks[file.id]
    if (oversized && task?.status === 'done' && task.serverId === file.serverId) {
      cancelUpload(file.id)
    }
    checked.set(file.id, oversized ? null : file.serverId)
  }
  return checked
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const VIEW_MIME_BY_EXT: Record<string, string> = {
  ...MIME_BY_EXT,
  apng: 'image/png',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  avif: 'image/avif',
  avifs: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** 展示附件时只按后缀确定类型。 */
export const getFileViewType = (name: string) => {
  const ext = getFileExt(name)
  return Object.hasOwn(VIEW_MIME_BY_EXT, ext) ? VIEW_MIME_BY_EXT[ext] : ''
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
