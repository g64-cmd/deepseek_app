import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { platform } from '../../platform/index.js'
import { loadFile } from '../../services/chat/db.js'
import { openModals } from '../base/modalStack.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './ImageViewer.module.css'

const ZOOM_SCALE = 2.5

/**
 * 附件图片全屏查看：黑底沉浸视图，双击在 1x 与 2.5x 间切换（以点击点为圆心），
 * 放大态单指拖拽平移；底部保存/分享原件。自注册进 modalStack，
 * 系统返回键与 Esc 只关闭本层。
 */
export const ImageViewer = ({ file, onClose }: { file: { id: string; name: string }; onClose: () => void }) => {
  const t = useTranslate()
  const [url, setUrl] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [sharing, setSharing] = useState(false)
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointer: number; startX: number; startY: number; originX: number; originY: number } | null>(null)

  // 与缩略图各自独立地建立 objectUrl，卸载各自 revoke
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    void loadFile(file.id).then((original) => {
      if (!original || cancelled) {
        return
      }
      objectUrl = URL.createObjectURL(original)
      setUrl(objectUrl)
      setBlob(original)
    })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [file.id])

  // 注册进浮层栈；onClose 引用变化不重复注册（与 Modal 相同的 ref 模式）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const entry = { close: () => onCloseRef.current() }
    openModals.push(entry)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === entry) {
        entry.close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(entry), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const toggleZoom = (clientX: number, clientY: number) => {
    if (zoom.scale === 1) {
      const rect = containerRef.current?.getBoundingClientRect()
      setZoom({
        scale: ZOOM_SCALE,
        x: rect ? clientX - rect.left : 0,
        y: rect ? clientY - rect.top : 0,
      })
    } else {
      setZoom({ scale: 1, x: 0, y: 0 })
    }
  }

  return createPortal(
    <div
      ref={containerRef}
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.header}>
        <span className={styles.name}>{file.name}</span>
        <IconButton
          tone="primary"
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={onClose}
        />
      </div>
      <div className={styles.stage}>
        {url ? (
          <img
            src={url}
            alt={file.name}
            className={styles.image}
            style={{
              transform: zoom.scale === 1 ? undefined : `scale(${ZOOM_SCALE})`,
              transformOrigin: zoom.scale === 1 ? undefined : `${zoom.x}px ${zoom.y}px`,
              cursor: zoom.scale === 1 ? 'zoom-in' : 'grab',
            }}
            onDoubleClick={(event) => {
              event.preventDefault()
              toggleZoom(event.clientX, event.clientY)
            }}
            onPointerDown={(event) => {
              if (zoom.scale === 1) {
                return
              }
              event.preventDefault()
              dragRef.current = {
                pointer: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: zoom.x,
                originY: zoom.y,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointer !== event.pointerId) {
                return
              }
              // 放大圆心随拖拽反向移动：等价于把图片朝指针方向平移
              setZoom((current) => ({
                ...current,
                x: drag.originX - (event.clientX - drag.startX),
                y: drag.originY - (event.clientY - drag.startY),
              }))
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointer === event.pointerId) {
                dragRef.current = null
              }
            }}
            draggable={false}
          />
        ) : (
          <span className={styles.loading} />
        )}
      </div>
      <div className={styles.footer}>
        <Button
          variant="outlined"
          size="s"
          disabled={!blob || sharing}
          onClick={() => {
            if (!blob) {
              return
            }
            setSharing(true)
            platform
              .saveOrShareFile(file.name, blob)
              .then(() => {
                // 用户收起分享面板视为取消，不算失败
              })
              .catch(() => {
                showToast({ key: 'imageViewerSaveFailed', type: 'error' })
              })
              .finally(() => {
                setSharing(false)
              })
          }}
        >
          {t(sharing ? 'imageViewerSaving' : 'imageViewerSaveShare')}
        </Button>
      </div>
    </div>,
    document.body,
  )
}
