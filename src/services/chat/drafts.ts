import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import type { FilePurpose } from '../api/types.js'
import {
  cancelUpload,
  isImage,
  isLayoutDocument,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import { useSettings } from '../settings.js'
import type { FileAttachment } from './types.js'
import { MAX_REQUEST_DOCUMENTS } from './reply.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  /** 上传目的在加入草稿时确定：版面文档按当前解析方式，图片为 null */
  purpose: FilePurpose | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿文本持久化 key：{ [sessionId]: text }，'null' 对应新对话 */
const DRAFT_TEXTS_KEY = 'chat-demo:draft-texts'
const DRAFT_SAVE_DELAY_MS = 400

const readDraftTexts = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_TEXTS_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
  } catch {
    // 损坏数据按无草稿处理
  }
  return {}
}

const writeDraftTexts = (texts: Record<string, string>) => {
  try {
    if (Object.keys(texts).length === 0) {
      localStorage.removeItem(DRAFT_TEXTS_KEY)
    } else {
      localStorage.setItem(DRAFT_TEXTS_KEY, JSON.stringify(texts))
    }
  } catch {
    // 存储不可用时只在内存生效
  }
}

const draftTextsOf = (drafts: ReadonlyMap<string | null, Draft>): Record<string, string> =>
  Object.fromEntries(
    [...drafts].filter(([, draft]) => draft.text).map(([id, draft]) => [String(id), draft.text])
  )

/** 未发送的文字跨进程保留（附件是上传中的临时状态，不持久化）；null 是新对话的草稿。 */
const restoreDrafts = (): Map<string | null, Draft> => {
  const drafts = new Map<string | null, Draft>()
  for (const [sessionId, text] of Object.entries(readDraftTexts())) {
    drafts.set(sessionId === 'null' ? null : sessionId, { text, attachments: [] })
  }
  return drafts
}

export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: restoreDrafts(),
}))

// 草稿变化防抖落盘：进程被杀后未发送的文字可恢复，发送/清空随内存状态同步移除
let saveTimer: ReturnType<typeof setTimeout> | null = null
useDrafts.subscribe((state) => {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeDraftTexts(draftTextsOf(state.drafts))
  }, DRAFT_SAVE_DELAY_MS)
})

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

/** 显式导出读取当前内存快照，不依赖防抖落盘成功或定时器已触发。 */
export const dumpDraftTexts = (): Record<string, string> =>
  draftTextsOf(useDrafts.getState().drafts)

/** 导入整体替换草稿，并立即尝试持久化；存储不可用时仍保留内存状态。 */
export const restoreDraftTexts = (texts: Record<string, string>) => {
  const drafts = new Map<string | null, Draft>()
  for (const [sessionId, text] of Object.entries(texts)) {
    if (text) {
      drafts.set(sessionId === 'null' ? null : sessionId, { text, attachments: [] })
    }
  }
  useDrafts.setState({ drafts })
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  writeDraftTexts(draftTextsOf(drafts))
}

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.purpose
  ).catch(() => {})
}

/** 上传目的：图片不传 purpose；版面文档按当前解析方式；其余非图片文件按 user_data。 */
const purposeOf = (file: File): FilePurpose | null => {
  if (isImage(resolveMimeType(file))) {
    return null
  }
  if (isLayoutDocument(file.name)) {
    return useSettings.getState().docParseMode === 'text'
      ? 'text_recognition'
      : 'rich_layout_recognition'
  }
  return 'user_data'
}

/** 整批校验通过后才加入草稿并开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const documents =
    getDraft(sessionId).attachments.filter((file) => !file.isImage).length +
    files.filter((file) => !isImage(resolveMimeType(file))).length
  if (documents > MAX_REQUEST_DOCUMENTS) {
    return { key: 'replyDocLimit', params: { count: documents } }
  }
  // 文件加入草稿即会上传；必须在这一边界确认，而不是等聊天发送时再提示。
  if (
    files.some((file) => isLayoutDocument(file.name)) &&
    !useSettings.getState().docBillingAcked
  ) {
    return { key: 'docBillingDescription' }
  }
  const added = files.map(
    (file): DraftAttachment => ({
      id: createId(),
      file,
      isImage: isImage(resolveMimeType(file)),
      purpose: purposeOf(file),
    })
  )
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, apiKey))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, apiKey)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      purpose: attachment.purpose,
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}
