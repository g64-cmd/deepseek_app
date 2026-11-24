import clsx from 'clsx'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconAccountOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  checkArchiveKind,
  clearHistory,
  exportFullBackup,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import type { ArchiveKind } from '../../services/chat/history/format.js'
import { useIsMobile } from '../../app/viewport.js'
import { platform } from '../../platform/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setDocParseMode,
  setLocale,
  setLocation,
  setModel,
  setThinkingEffort,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type DocParseMode,
  type ThemePreference,
} from '../../services/settings.js'
import { MODEL_METAS } from '../../services/models.js'
import type { EffortLevel } from '../../services/api/types.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { BalancePanel, UsagePanel } from './AccountPanels.js'
import {
  closeSettings,
  setSettingsSection,
  useSettingsDialog,
  type SettingsSection,
} from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  {
    value: 'account',
    label: 'settingDialogAsideAccountOptionLabel',
    icon: <IconAccountOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const tabsId = useId()
  const isMobile = useIsMobile()
  const section = useSettingsDialog((state) => state.section)
  const focusTab = useRef(false)
  useLayoutEffect(() => {
    if (focusTab.current) {
      document.getElementById(`${tabsId}-${section}`)?.focus()
      focusTab.current = false
    }
  }, [section, tabsId])
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div
          role="tablist"
          aria-label={t('settings')}
          aria-orientation={isMobile ? 'horizontal' : 'vertical'}
          className={styles.navigation}
        >
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`${tabsId}-${item.value}`}
              aria-controls={`${tabsId}-panel`}
              tabIndex={section === item.value ? 0 : -1}
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSettingsSection(item.value)}
              onKeyDown={(event) => {
                const previous = isMobile ? 'ArrowLeft' : 'ArrowUp'
                const next = isMobile ? 'ArrowRight' : 'ArrowDown'
                let index = sections.findIndex((entry) => entry.value === item.value)
                if (event.key === previous) {
                  index = (index + sections.length - 1) % sections.length
                } else if (event.key === next) {
                  index = (index + 1) % sections.length
                } else if (event.key === 'Home') {
                  index = 0
                } else if (event.key === 'End') {
                  index = sections.length - 1
                } else {
                  return
                }
                event.preventDefault()
                focusTab.current = true
                setSettingsSection(sections[index].value)
                document.getElementById(`${tabsId}-${sections[index].value}`)?.focus()
              }}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-${section}`}
          tabIndex={0}
          className={styles.content}
        >
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <ModelSetting />
              <ThinkingEffortSetting />
              <DocParseModeSetting />
            </>
          ) : section === 'account' ? (
            <>
              <BalancePanel />
              <UsagePanel />
            </>
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <ExportFullBackup disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            data-initial-focus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 模型选择：每条回复单独快照当前模型，这里只影响新回复；能力差异写入描述 */
const ModelSetting = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  return (
    <SettingCell
      label={t('settingsModel')}
      description={t('settingsModelDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsModel')}
          value={model}
          options={Object.values(MODEL_METAS).map((meta) => ({
            value: meta.id,
            label: t(meta.id === 'deepseek-flash' ? 'modelFlash' : 'modelPro'),
          }))}
          onChange={setModel}
        />
      }
    />
  )
}

/** 文档解析方式：决定之后上传的版面文档交给模型的内容；已上传的附件沿用保存的 purpose */
const DocParseModeSetting = () => {
  const t = useTranslate()
  const docParseMode = useSettings((state) => state.docParseMode)
  const options: { value: DocParseMode; label: string }[] = [
    { value: 'text', label: t('docParseModeText') },
    { value: 'rich', label: t('docParseModeRich') },
  ]
  return (
    <SettingCell
      label={t('settingsDocParseMode')}
      description={t('settingsDocParseModeDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsDocParseMode')}
          value={docParseMode}
          options={options}
          onChange={setDocParseMode}
        />
      }
    />
  )
}

/** 思考强度：仅深度思考开启时随请求携带（output_config.effort），每条回复单独快照 */
const ThinkingEffortSetting = () => {
  const t = useTranslate()
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  const options: { value: EffortLevel; label: string }[] = [
    { value: 'low', label: t('effortLow') },
    { value: 'high', label: t('effortHigh') },
    { value: 'max', label: t('effortMax') },
  ]
  return (
    <SettingCell
      label={t('settingsThinkingEffort')}
      description={t('settingsThinkingEffortDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsThinkingEffort')}
          value={thinkingEffort}
          options={options}
          onChange={setThinkingEffort}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上；完整备份额外提供「先导出备份」入口 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const full = historyImport.kind === 'full'
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      returnFocus={historyImport.opener.current}
      footer={
        <>
          <Button variant="outlined" size="m" data-initial-focus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        {t(full ? 'historyImportFullConfirmDescription' : 'historyImportConfirmDescription')}
      </div>
      {full ? <ExportBackupFirst /> : null}
    </Modal>
  )
}

/** 完整备份导入确认里的「先导出备份」：走导出链路（分享面板存盘），不关闭确认弹窗 */
const ExportBackupFirst = () => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className={styles.importConfirmActions}>
      <Button
        variant="outlined"
        size="s"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailed(false)
          exportFullBackup()
            .then(({ name, blob }) => platform.saveOrShareFile(name, blob))
            .then(() => {
              // 用户收起分享面板视为取消，同样不算失败
            })
            .catch(() => {
              setFailed(true)
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {t('backupFirst')}
      </Button>
      {failed ? (
        <span className={clsx(styles.description, styles.error)}>
          {t('historyExportFailed', { message: '' })}
        </span>
      ) : null}
    </div>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const name = useId()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <label
            key={option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
          >
            <input
              className="sr-only"
              type="radio"
              name={name}
              value={option.value}
              checked={themePreference === option.value}
              onChange={() => setThemePreference(option.value)}
            />
            {option.icon}
            {t(option.label)}
          </label>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div
            data-setting-description
            className={clsx(styles.description, status?.error && styles.error)}
          >
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后识别归档格式，再确认覆盖并导入；检查或导入错误均提示失败。 */
const useHistoryImport = () => {
  const opener = useRef<HTMLElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<ArchiveKind>('legacy')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  /** 选中文件即校验格式并识别归档类型，确认弹窗据此区分兼容格式与完整备份 */
  const select = (selected: File) => {
    // busy 会禁用上传按钮并移走焦点，必须在异步格式检查开始前保存触发器。
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setStatus(null)
    setBusy(true)
    checkArchiveKind(selected)
      .then((kind) => {
        setFile(selected)
        setKind(kind)
      })
      .catch((error) => {
        setStatus(errorStatus('historyImportFailed', error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const { count, restoredSettings } = await importHistory(file)
      setStatus({
        key: restoredSettings
          ? count === 1
            ? 'historyImportedFullOne'
            : 'historyImportedFull'
          : count === 1
            ? 'historyImportedOne'
            : 'historyImported',
        params: { count },
      })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, kind, busy, status, select, opener, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 导出类操作的公共单元：按钮触发导出并经平台保存/分享 */
const ExportCell = ({
  label,
  description,
  actionLabel,
  disabled,
  run,
}: {
  label: string
  description: string
  actionLabel: string
  disabled: boolean
  run: () => Promise<{ name: string; blob: Blob }>
}) => {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  return (
    <SettingCell
      label={label}
      description={description}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy}
          onClick={() => {
            setBusy(true)
            setStatus(null)
            run()
              .then(({ name, blob }) => platform.saveOrShareFile(name, blob))
              .catch((error) => {
                setStatus(errorStatus('historyExportFailed', error))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          <IconDownloadOutline16 />
          {actionLabel}
        </Button>
      }
    />
  )
}

/** 兼容官方 App 的历史导出；全部会话与本地图片原件（无会话时禁用） */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  return (
    <ExportCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      actionLabel={t('exportAllDownload')}
      disabled={disabled || empty}
      run={exportHistory}
    />
  )
}

/** 完整应用备份：会话（含用量与模型快照）、全部附件原件、设置与草稿；不含 API Key */
const ExportFullBackup = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  return (
    <ExportCell
      label={t('backupFullExport')}
      description={t('backupFullExportDescription')}
      actionLabel={t('backupFullDownload')}
      disabled={disabled}
      run={exportFullBackup}
    />
  )
}
