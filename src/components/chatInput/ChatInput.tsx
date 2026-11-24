import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconGlobeLanguageOutline14,
  IconLightOutline16,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
  IconThinkOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import {
  setDocBillingAcked,
  setDocParseMode,
  setModel,
  setSearch,
  setThinking,
  useSettings,
  type DocParseMode,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  countContextDocuments,
  countContextImages,
  sendMessage,
  stopReply,
  useChatStore,
} from '../../services/chat/store.js'
import { MAX_REQUEST_DOCUMENTS } from '../../services/chat/reply.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { MODEL_METAS, supportsVision } from '../../services/models.js'
import {
  ACCEPT,
  isImage as isImageFile,
  isLayoutDocument,
  resolveMimeType,
  validateFiles,
  useUploads,
} from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const model = useSettings((state) => state.model)
  /** V4 Pro 携带图片时的发送确认；draft/history 分别为草稿与上下文历史中的图片数 */
  const [imageConfirm, setImageConfirm] = useState<{ draft: number; history: number } | null>(null)
  const [documentFiles, setDocumentFiles] = useState<File[] | null>(null)
  const [parseMode, setParseMode] = useState<DocParseMode>(useSettings.getState().docParseMode)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    // 当前模型不支持图片时不允许添加，避免用户整理好文字后才发现发不出去
    if (
      !supportsVision(useSettings.getState().model) &&
      files.some((file) => isImageFile(file.type))
    ) {
      showToast({ key: 'modelNoVisionImageRejected' })
      return
    }
    const draft = getDraft(sessionId)
    const error = validateFiles(files, draft.attachments.length)
    if (error) {
      showToast(error)
      return
    }
    const count =
      countContextDocuments(sessionId) +
      draft.attachments.filter((file) => !file.isImage).length +
      files.filter((file) => !isImageFile(resolveMimeType(file))).length
    if (count > MAX_REQUEST_DOCUMENTS) {
      showToast({ key: 'replyDocLimit', params: { count }, type: 'error' })
      return
    }
    if (
      files.some((file) => isLayoutDocument(file.name)) &&
      !useSettings.getState().docBillingAcked
    ) {
      setParseMode(useSettings.getState().docParseMode)
      setDocumentFiles(files)
      return
    }
    const uploadError = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (uploadError) {
      showToast(uploadError)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送；
  // 当前模型不支持图片而草稿里仍有图片（如切换模型后遗留）时同样不能直接发送
  const draftImagesBlocked = !supportsVision(model) && attachments.some((file) => file.isImage)
  const canSend =
    !importingHistory && !streaming && voice.status === 'idle' && draftReady && !draftImagesBlocked

  const submit = (options?: { dropHistoryImages?: boolean }) => {
    if (
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks) ||
      !sendMessage(sessionId, options)
    ) {
      return false
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
    return true
  }

  const send = () => {
    if (useChatStore.getState().importingHistory || voice.status !== 'idle') {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey()) {
      return
    }
    if (!supportsVision(useSettings.getState().model)) {
      const draftImages = getDraft(sessionId).attachments.filter((file) => file.isImage).length
      const historyImages = countContextImages(sessionId)
      if (draftImages > 0 || historyImages > 0) {
        setImageConfirm({ draft: draftImages, history: historyImages })
        return
      }
    }
    submit()
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      {draftImagesBlocked ? (
        <div className={styles.modelWarning}>
          <IconWarningOutline16 />
          <span>
            {t('modelNoVisionDraftWarning', {
              count: attachments.filter((file) => file.isImage).length,
            })}
          </span>
        </div>
      ) : null}
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          aria-label={t('chatInputLabel')}
          data-focus-fallback
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={t('deactivatedThinkTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          <Tooltip content={t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
          {/* 模型选择：每条回复单独快照，这里只影响即将发出的请求 */}
          <Menu
            options={Object.values(MODEL_METAS).map((meta) => ({
              key: meta.id,
              label: t(meta.id === 'deepseek-flash' ? 'modelFlash' : 'modelPro'),
              icon: meta.vision ? <IconLightOutline16 /> : <IconThinkOutline16 />,
              onSelect: () => setModel(meta.id),
            }))}
          >
            {({ open, toggle }) => (
              <Tooltip content={t('modelSwitch')}>
                <button
                  type="button"
                  className={clsx(styles.toggle, open && styles.selected)}
                  aria-label={t('modelSwitch')}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  {MODEL_METAS[model].shortName}
                  <IconChevronDownOutline14 />
                </button>
              </Tooltip>
            )}
          </Menu>
        </div>
        <div className={styles.right}>
          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPaperclipOutline16 />}
            tooltip={t('uploadFile')}
            disabled={importingHistory}
            onClick={() => ensureApiKey() && fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
      {documentFiles ? (
        <Modal
          title={t('docBillingTitle')}
          className={styles.documentDialog}
          mainClassName={styles.documentMain}
          onClose={() => setDocumentFiles(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDocumentFiles(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={importingHistory}
                onClick={() => {
                  if (useChatStore.getState().importingHistory || !ensureApiKey()) {
                    return
                  }
                  setDocParseMode(parseMode)
                  setDocBillingAcked(true)
                  const selected = documentFiles
                  setDocumentFiles(null)
                  acceptFiles(selected)
                }}
              >
                {t('docBillingConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('docBillingDescription')}</p>
          <ul className={styles.documentFiles}>
            {documentFiles.map((file, index) => (
              <li key={index}>{file.name}</li>
            ))}
          </ul>
          <fieldset className={styles.documentMode}>
            <legend>{t('settingsDocParseMode')}</legend>
            {(['text', 'rich'] as const).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="doc-parse-mode"
                  checked={parseMode === mode}
                  onChange={() => setParseMode(mode)}
                />
                {t(mode === 'text' ? 'docParseModeText' : 'docParseModeRich')}
              </label>
            ))}
          </fieldset>
        </Modal>
      ) : null}
      {imageConfirm ? (
        <Modal
          title={t('modelImageConfirmTitle')}
          onClose={() => {
            setImageConfirm(null)
          }}
          footer={
            <>
              <Button variant="outlined" onClick={() => setImageConfirm(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  // 移除草稿图片后仅发文字；历史图片经 dropHistoryImages 在请求组装时剔除
                  const draft = getDraft(sessionId)
                  for (const file of draft.attachments.filter((item) => item.isImage)) {
                    removeDraftAttachment(sessionId, file.id)
                  }
                  setImageConfirm(null)
                  if (useChatStore.getState().importingHistory || voice.status !== 'idle') {
                    return
                  }
                  if (ensureApiKey()) {
                    submit({ dropHistoryImages: imageConfirm.history > 0 })
                  }
                }}
              >
                {t('modelImageSendTextOnly', {
                  count: imageConfirm.draft + imageConfirm.history,
                })}
              </Button>
              <Button
                onClick={() => {
                  setModel('deepseek-flash')
                  setImageConfirm(null)
                  if (useChatStore.getState().importingHistory || voice.status !== 'idle') {
                    return
                  }
                  if (ensureApiKey()) {
                    submit()
                  }
                }}
              >
                {t('modelImageSwitchToSend')}
              </Button>
            </>
          }
        >
          {t('modelImageConfirmDescription', {
            draft: imageConfirm.draft,
            history: imageConfirm.history,
          })}
        </Modal>
      ) : null}
    </div>
  )
}
