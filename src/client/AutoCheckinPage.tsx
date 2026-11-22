/**
 * The auto-check-in claim ledger, as a PAGE.
 *
 * WHY A PAGE AND NOT A DIALOG
 *
 * This started as a dialog opened from the channel's automation panel. The
 * dialog could only answer "what happened in the run I am looking at" — it
 * covered the pool while open, and the whole point of a ledger is comparison:
 * across runs, across channels, across accounts. A dialog you have to dismiss
 * to see the pool again cannot be read that way.
 *
 * So it is a rail page, next to Dashboard and Routing. The rail is the plugin's
 * own "everything, at a glance" surface, and a claim ledger belongs there.
 *
 * IT REUSES THE 3.0 VOCABULARY
 *
 * `main.mhead` + `mbody` like every other page, and the receipt rows keep the
 * `.ledger-*` rules (dotted leader, group tone) from the shared sheet. The only
 * page-specific decisions are: the run picker and "claim now" live in the
 * header, and the summary counts sit above the groups so the reader sees totals
 * before detail.
 *
 * @module dsh-xdpool/client/AutoCheckinPage
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  autoCheckinFrom,
  callPack,
  runAutoCheckin,
  type ChannelAutoCheckin,
  type ChannelAutoCheckinDetail,
  type ChannelAutoCheckinRun,
} from './channel-rpc.ts'
import type { XdPoolSettingsKey } from './locales.ts'

type Translate = (key: XdPoolSettingsKey, params?: Record<string, unknown>) => string

/** The four buckets rows are grouped into, in receipt order. */
type Group = 'success' | 'already' | 'failed' | 'other'

const GROUPS: readonly Group[] = ['success', 'already', 'failed', 'other']

function groupOf(status: string): Group {
  if (status === 'claimed') return 'success'
  if (status === 'already-claimed') return 'already'
  if (status === 'failed') return 'failed'
  return 'other'
}

/** Label for a provider-level status that has no per-account reason. */
function statusLabel(status: string, t?: Translate): string {
  switch (status) {
    case 'skipped': return t?.('auto.details.manual') ?? '需手动签到'
    case 'unsupported': return t?.('auto.details.unsupported') ?? '无签到接口'
    case 'none': return t?.('auto.details.none') ?? '没有可领的'
    case 'inactive': return t?.('auto.details.inactive') ?? '当前不可领'
    default: return status
  }
}

/** "+100 积分" / "+2500 tokens" — the amount, in the vendor's own unit. */
function amountOf(row: ChannelAutoCheckinDetail): string {
  if (row.amount === undefined) return ''
  const unit = row.unit === 'token' ? 'tokens' : '积分'
  const sign = row.amount > 0 ? '+' : ''
  return `${sign}${String(row.amount)} ${unit}`
}

/** "11-13 14:34" — compact, in the viewer's own clock. */
function runLabel(run: ChannelAutoCheckinRun): string {
  const d = new Date(run.at)
  if (Number.isNaN(d.getTime())) return run.date !== '' ? run.date : String(run.at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface AutoCheckinPageProps {
  t?: Translate | undefined
  /** Provider id → display name, so rows read "Qoder 中国版", not "qodercn". */
  names?: Record<string, string> | undefined
}

export function AutoCheckinPage({ t, names }: AutoCheckinPageProps): ReactElement {
  const [state, setState] = useState<ChannelAutoCheckin | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /**
   * Which run is on the receipt. `live` is the current snapshot; an index
   * points into history. If the live snapshot is empty but history is not,
   * start on the newest run — data one click away must not read as "none".
   */
  const [selected, setSelected] = useState<string>('live')

  const load = useCallback(async (): Promise<void> => {
    try {
      const envelope = await callPack('usage.autoCheckin', {})
      if (!mounted.current) return
      setState(autoCheckinFrom(envelope))
      setError(undefined)
    } catch (cause) {
      // The pack not answering is not a page failure: the switch stays absent
      // and the reader is told why, rather than shown an empty receipt.
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const rows = state?.details ?? []
  const history = state?.history ?? []

  /** Rule 3 from the original dialog, unchanged: never steal an explicit pick. */
  useEffect(() => {
    if (selected !== 'live') return
    if (rows.length > 0) return
    if (history.length > 0) setSelected(String(history.length - 1))
  }, [selected, rows.length, history.length])

  /**
   * Force one pass. The scheduled run refuses a second pass on the same day, so
   * this is the only way to retry an account that failed this morning.
   */
  const runNow = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      const next = await runAutoCheckin()
      if (!mounted.current) return
      /*
        An error envelope is NOT a throw: `runAutoCheckin` folds the pack's
        `{ok:false}` into `undefined`, so swallowing it here would repaint the
        page with stale data and say nothing.
      */
      if (next === undefined) {
        setError('强制领取失败（pack 没有返回新的账本）')
        return
      }
      setState(next)
      setError(undefined)
      // A fresh pass becomes the newest history entry; show it.
      setSelected('live')
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setRunning(false)
    }
  }, [])

  const shownRows = useMemo(() => {
    if (selected === 'live') return rows
    const run = history[Number(selected)]
    return run === undefined ? rows : run.details
  }, [selected, rows, history])

  /**
   * The run the headline totals describe — ONLY when those totals actually
   * describe what is shown. On `live` with rows the newest ancestor is the right
   * headline; on `live` with NO rows that ancestor's total would describe
   * nothing visible, so the headline is withheld rather than allowed to
   * disagree with the body.
   */
  const headerRun = useMemo(() => {
    if (selected !== 'live') return history[Number(selected)]
    return rows.length > 0 && history.length > 0 ? history[history.length - 1] : undefined
  }, [selected, rows.length, history])

  const grouped = useMemo(() => {
    const map: Record<Group, ChannelAutoCheckinDetail[]> = { success: [], already: [], failed: [], other: [] }
    const sorted = [...shownRows].sort((a, b) =>
      a.provider.localeCompare(b.provider) || (a.nickname ?? '').localeCompare(b.nickname ?? ''))
    for (const row of sorted) map[groupOf(row.status)].push(row)
    return map
  }, [shownRows])

  /** Headline counts: how many channels / accounts this run touched, and how it went. */
  const channels = useMemo(() => new Set(shownRows.map(row => row.provider)).size, [shownRows])
  const accounts = shownRows.length
  const totalCredit = headerRun?.totals?.credit ?? 0
  const failedCount = grouped.failed.length
  const whenText = state?.lastAt === undefined
    ? (t?.('auto.details.noRun') ?? '还没有完成过领取。')
    : new Date(state.lastAt).toLocaleString()

  return (
    <main className="main">
      <header className="mhead">
        <div className="mhead-title">
          <span className="mhead-name">{t?.('auto.details.title') ?? '领取详情'}</span>
          <span className="mhead-org">
            {`逐账号领取账本 · ${whenText}`}
          </span>
        </div>
        <div className="mhead-actions">
          <label className="ledger-pick">
            <span>{t?.('auto.details.run') ?? '轮次'}</span>
            <select
              value={selected}
              disabled={running}
              onChange={(event) => { setSelected(event.target.value) }}
            >
              <option value="live">{t?.('auto.details.latest') ?? '最近一轮'}</option>
              {history.map((run, index) => ({ run, index })).reverse().map(({ run, index }) => (
                <option key={run.at} value={String(index)}>
                  {runLabel(run)}
                  {run.runs !== undefined && run.runs > 1 ? ` · ×${String(run.runs)}` : ''}
                  {run.totals.credit !== undefined && run.totals.credit > 0 ? ` · +${String(run.totals.credit)}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            onClick={() => { void runNow() }}
          >
            {running
              ? (t?.('auto.details.running') ?? '领取中…')
              : (t?.('auto.details.runNow') ?? '立即领取')}
          </button>
        </div>
      </header>

      <div className="mbody">
        {error === undefined ? null : (
          <div className="hint" role="alert"><b>提示</b><span>{error}</span></div>
        )}

        {/*
          The headline numbers sit above the groups: a ledger is read totals-first,
          then the lines that make them up. Same .kpis component every other page
          uses, so it lines up with the pool's own stat row.
        */}
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}>
          <div className="kpi">
            <span className="kpi-k">渠道</span>
            <span className="kpi-v num">{loading ? '…' : String(channels)}</span>
          </div>
          <div className="kpi">
            <span className="kpi-k">账号</span>
            <span className="kpi-v num">{loading ? '…' : String(accounts)}</span>
          </div>
          <div className="kpi">
            <span className="kpi-k">{t?.('auto.details.success') ?? '领取成功'}</span>
            <span className="kpi-v num">{loading ? '…' : String(grouped.success.length)}</span>
          </div>
          <div className="kpi">
            <span className="kpi-k">{t?.('auto.details.failed') ?? '领取失败'}</span>
            <span className="kpi-v num" data-tone={failedCount > 0 ? 'err' : undefined}>
              {loading ? '…' : String(failedCount)}
            </span>
          </div>
        </div>

        {/* The receipt itself. */}
        <section className="sec">
          <div className="sec-head">
            <span className="sec-title">逐账号</span>
            <span className="sec-n num">{String(accounts)}</span>
            {headerRun === undefined ? null : (
              <span className="sec-actions">
                <span className="hint" title={headerRun.result}>
                  {`本轮合计 ${totalCredit > 0 ? `+${String(totalCredit)}` : String(totalCredit)} ${t?.('auto.details.creditUnit') ?? '积分'}`}
                </span>
              </span>
            )}
          </div>

          {accounts === 0 && !loading && (
            <p className="hint">
              {history.length === 0
                ? (t?.('auto.details.empty') ?? '还没有逐账号记录。点「立即领取」跑一轮，或等下一次定时领取。')
                : (t?.('auto.details.runEmpty') ?? '这一轮没有记录到逐账号明细。')}
            </p>
          )}

          {GROUPS.map(group => {
            const items = grouped[group]
            if (items.length === 0) return null
            const label = group === 'success' ? (t?.('auto.details.success') ?? '领取成功')
              : group === 'already' ? (t?.('auto.details.already') ?? '今天已领')
                : group === 'failed' ? (t?.('auto.details.failed') ?? '领取失败')
                  : (t?.('auto.details.other') ?? '暂不可领 / 已跳过')
            return (
              <section key={group} className="ledger-group" data-tone={group}>
                <h4 className="ledger-grouphead">
                  <span className="ledger-dot" aria-hidden="true" />
                  <span className="ledger-grouplabel">{label}</span>
                  <span className="ledger-rule" aria-hidden="true" />
                  <span className="ledger-count">{items.length}</span>
                </h4>
                <ul className="ledger-rows">
                  {items.map((row, index) => {
                    const provider = names?.[row.provider] ?? row.provider
                    const who = row.nickname !== undefined && row.nickname !== ''
                      ? `${provider} · ${row.nickname}`
                      : provider
                    const amount = amountOf(row)
                    const reason = row.reason !== undefined && row.reason !== ''
                      ? row.reason
                      : statusLabel(row.status, t)
                    return (
                      <li key={`${row.provider}:${row.accountId ?? row.nickname ?? 'provider'}:${String(index)}`} className="ledger-line">
                        <div className="ledger-row">
                          <span className="ledger-who" title={row.accountId ?? who}>{who}</span>
                          <span className="ledger-leader" aria-hidden="true" />
                          {amount !== ''
                            ? <span className="ledger-amount" data-tone={group}>{amount}</span>
                            : <span className="ledger-namount">{statusLabel(row.status, t)}</span>}
                        </div>
                        <div className="ledger-why">
                          {reason}
                          {row.code !== undefined && row.code !== 0 && (
                            <span className="ledger-code"> · code {String(row.code)}</span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </section>
      </div>
    </main>
  )
}
