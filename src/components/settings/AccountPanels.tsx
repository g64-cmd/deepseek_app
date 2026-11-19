import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { ensureBalance, refreshBalance, useBalance } from '../../services/balance.js'
import {
  estimateCostRange,
  getUsageSummary,
  type UsageSummary,
} from '../../services/usage.js'
import { MODEL_METAS } from '../../services/models.js'
import { openSettings } from './settingsDialogState.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

/**
 * 账户分区：余额（GET /user/balance，真实数据）与用量（本地会话 usage 聚合 + 单价估算区间）。
 * 金额均为展示用途：余额直接展示服务端字符串，用量金额是按公开单价的估算。
 */

const formatTokens = (value: number) => value.toLocaleString()

const formatRange = (range: { min: number; max: number }) => {
  const fmt = (value: number) =>
    value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4)
  return `${fmt(range.min)} ~ ${fmt(range.max)}`
}

export const BalancePanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const data = useBalance((state) => state.data)
  const fetchedAt = useBalance((state) => state.fetchedAt)
  const loading = useBalance((state) => state.loading)
  const error = useBalance((state) => state.error)

  useEffect(() => {
    ensureBalance()
  }, [])

  if (!apiKey) {
    return (
      <div className={styles.accountBlock}>
        <div className={styles.accountHeading}>{t('accountBalance')}</div>
        <div className={styles.accountNote}>{t('accountBalanceNotConfigured')}</div>
        <Button variant="outlined" size="s" onClick={() => openSettings('data')}>
          {t('accountBalanceGoToKey')}
        </Button>
      </div>
    )
  }

  const infos = data?.balance_infos ?? []
  return (
    <div className={styles.accountBlock}>
      <div className={styles.accountHeadingRow}>
        <span className={styles.accountHeading}>{t('accountBalance')}</span>
        <Button
          variant="outlined"
          size="s"
          disabled={loading}
          onClick={() => {
            void refreshBalance()
          }}
        >
          {loading ? t('accountBalanceRefreshing') : t('accountBalanceRefresh')}
        </Button>
      </div>
      {data?.is_available === false ? (
        <div className={styles.accountWarn}>{t('accountBalanceUnavailable')}</div>
      ) : null}
      {error ? (
        <div className={styles.accountWarn}>
          {t(
            error === 'network'
              ? 'accountBalanceErrorNetwork'
              : error === 'unauthorized'
                ? 'accountBalanceErrorUnauthorized'
                : 'accountBalanceErrorOther'
          )}
        </div>
      ) : null}
      {infos.length === 0 && !loading && !error ? (
        <div className={styles.accountNote}>{t('accountBalanceEmpty')}</div>
      ) : null}
      {infos.map((info) => (
        <div key={info.currency} className={styles.accountGroup}>
          <div className={styles.accountGroupTitle}>{info.currency}</div>
          <div className={styles.accountRow}>
            <span>{t('accountBalanceTotal')}</span>
            <span className={styles.accountValue}>{info.total_balance}</span>
          </div>
          <div className={styles.accountRow}>
            <span>{t('accountBalanceGranted')}</span>
            <span className={styles.accountValue}>{info.granted_balance}</span>
          </div>
          <div className={styles.accountRow}>
            <span>{t('accountBalanceToppedUp')}</span>
            <span className={styles.accountValue}>{info.topped_up_balance}</span>
          </div>
        </div>
      ))}
      {fetchedAt ? (
        <div className={styles.accountNote}>{t('accountBalanceUpdatedAt', {
          time: new Date(fetchedAt).toLocaleString(),
        })}</div>
      ) : null}
    </div>
  )
}

export const UsagePanel = () => {
  const t = useTranslate()
  const [state, setState] = useState<{ loading: boolean; summary: UsageSummary | null }>({
    loading: true,
    summary: null,
  })

  useEffect(() => {
    let cancelled = false
    void getUsageSummary().then(
      (summary) => {
        if (!cancelled) {
          setState({ loading: false, summary })
        }
      },
      () => {
        if (!cancelled) {
          setState({ loading: false, summary: null })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const summary = state.summary
  return (
    <div className={styles.accountBlock}>
      <div className={styles.accountHeading}>{t('accountUsage')}</div>
      {state.loading ? (
        <div className={styles.accountNote}>{t('accountUsageComputing')}</div>
      ) : !summary || summary.replies === 0 ? (
        <div className={styles.accountNote}>{t('accountUsageEmpty')}</div>
      ) : (
        <>
          {Object.entries(summary.models).map(([id, usage]) =>
            usage ? (
              <div key={id} className={styles.accountGroup}>
                <div className={styles.accountGroupTitle}>
                  {MODEL_METAS[id as keyof typeof MODEL_METAS]?.shortName ?? id}
                </div>
                <div className={styles.accountRow}>
                  <span>{t('accountUsageInputCacheMiss')}</span>
                  <span className={styles.accountValue}>{formatTokens(usage.input)}</span>
                </div>
                <div className={styles.accountRow}>
                  <span>{t('accountUsageInputCacheRead')}</span>
                  <span className={styles.accountValue}>{formatTokens(usage.cacheRead)}</span>
                </div>
                <div className={styles.accountRow}>
                  <span>{t('accountUsageOutput')}</span>
                  <span className={styles.accountValue}>{formatTokens(usage.output)}</span>
                </div>
              </div>
            ) : null
          )}
          {summary.webSearchRequests + summary.toolSearch > 0 ? (
            <div className={styles.accountRow}>
              <span>{t('accountUsageSearch')}</span>
              <span className={styles.accountValue}>
                {formatTokens(summary.webSearchRequests + summary.toolSearch)}
              </span>
            </div>
          ) : null}
          <div className={styles.accountRow}>
            <span>{t('accountUsageEstimatedCost')}</span>
            <span className={styles.accountValue}>
              ¥ {formatRange(estimateCostRange(summary))}
            </span>
          </div>
          <div className={styles.accountNote}>{t('accountUsageEstimateNote')}</div>
        </>
      )}
    </div>
  )
}
