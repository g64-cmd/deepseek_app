import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { platform } from '../../platform/index.js'
import { useFocusLayer } from '../base/useFocusLayer.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconPhotoErrorFill20 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { useFileView } from '../files/useFileView.js'
import styles from './ImageViewer.module.css'

const ZOOM_SCALE = 2.5

/**
 * 附件图片全屏查看：黑底沉浸视图，双击在 1x 与 2.5x 间切换（以点击点为圆心），
 * 放大态单指拖拽平移；底部保存/分享原件。自注册进 modalStack，
 * 系统返回键与 Esc 只关闭本层。
 */
export const ImageViewer = ({
  source,
  name,
  onClose,
}: {
  source: File | string
  name: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const { url, blob } = useFileView(source, name)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 })
  const imageRef = useRef<HTMLImageElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusLayer(rootRef, onClose)
  const dragRef = useRef<{
    pointer: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const toggleZoom = (clientX: number, clientY: number) => {
    if (zoom.scale === 1) {
      // transform-origin 相对图片自身；1x 时图片无变换，边界即未缩放位置。
      // 不能用遮罩坐标：图片在 header/footer 之间的 stage 中居中，两套坐标系有偏移。
      const rect = imageRef.current?.getBoundingClientRect()
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
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.header}>
        <span tabIndex={0} className={styles.name}>
          {name}
        </span>
        <IconButton
          tone="primary"
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={onClose}
        />
      </div>
      <div className={styles.stage}>
        {url && failedUrl !== url ? (
          <img
            ref={imageRef}
            src={url}
            alt={name}
            onError={() => setFailedUrl(url)}
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
        ) : url === undefined ? (
          <span className={styles.loading} />
        ) : (
          <span role="img" aria-label={name}>
            <IconPhotoErrorFill20 />
          </span>
        )}
      </div>
      <div className={styles.footer}>
        <Button
          variant="outlined"
          size="s"
          disabled={!url || failedUrl === url || zoom.scale > 1}
          onClick={() => {
            const rect = imageRef.current?.getBoundingClientRect()
            if (rect) {
              toggleZoom(rect.left + rect.width / 2, rect.top + rect.height / 2)
            }
          }}
        >
          {t('imageViewerZoomIn')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={zoom.scale === 1}
          onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}
        >
          {t('imageViewerReset')}
        </Button>
        {zoom.scale > 1 ? (
          <>
            {(['Left', 'Right', 'Up', 'Down'] as const).map((direction) => (
              <Button
                key={direction}
                variant="outlined"
                size="s"
                onClick={() =>
                  setZoom((current) => ({
                    ...current,
                    x: current.x + (direction === 'Left' ? 40 : direction === 'Right' ? -40 : 0),
                    y: current.y + (direction === 'Up' ? 40 : direction === 'Down' ? -40 : 0),
                  }))
                }
              >
                {t(`imageViewerPan${direction}`)}
              </Button>
            ))}
          </>
        ) : null}
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
              .saveOrShareFile(name, blob)
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
    document.body
  )
}
