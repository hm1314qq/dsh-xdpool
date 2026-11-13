/**
 * The auto-check-in claim ledger.
 *
 * The reader opens this to answer one question: who collected what, who
 * failed, and why. So the design borrows from a till receipt: a big total up
 * top, dotted-leader rows between the account and its amount, and the
 * upstream's own failure message quoted underneath. Everything is tabular and
 * monospaced where it counts — this is a ledger, not a marketing card.
 *
 * Behavioural notes learned the hard way:
 *
 *  1. The stylesheet travels WITH the component; a page-scoped <style> never
 *     reaches a dialog rendered elsewhere.
 *  2. The dialog owns no fetching. The parent refreshes on open and after a
 *     manual run, so there is exactly one source of truth.
 *  3. When the live snapshot has no rows but history does, the picker defaults
 *     to the newest run — "empty" should never be the first thing a reader
 *     sees when data exists one click away.
 *
 * @module dsh-xdpool/client/AutoCheckinDetails
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ChannelAutoCheckinDetail, ChannelAutoCheckinRun } from './channel-rpc.ts'
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
    case 'skipped': return t?.('auto.details.manual') ?? 'Manual check-in required'
    case 'unsupported': return t?.('auto.details.unsupported') ?? 'No check-in API'
    case 'none': return t?.('auto.details.none') ?? 'Nothing to claim'
    case 'inactive': return t?.('auto.details.inactive') ?? 'Not claimable right now'
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

interface LedgerProps {
  /** Breakdown of the current/last run. */
  rows: readonly ChannelAutoCheckinDetail[]
  /** Rolling history, oldest first. */
  history: readonly ChannelAutoCheckinRun[]
  /** Epoch ms of the last completed run. */
  lastAt?: number | undefined
  /** True while a manual pass is in flight; disables the action. */
  running: boolean
  /** Provider id → display name, so rows read "Qoder 中国版", not "qodercn". */
  names: Record<string, string> | undefined
  t?: Translate | undefined
  onClose: () => void
  /** Force one batch claim; the parent refreshes state afterwards. */
  onRunNow: () => void
}

export function AutoCheckinDetailsDialog({
  rows,
  history,
  lastAt,
  running,
  names,
  t,
  onClose,
  onRunNow,
}: LedgerProps): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null)
  /**
   * Which run is on the receipt. `live` is the current snapshot; an index
   * points into history. If the live snapshot is empty but history is not,
   * start on the newest run — data one click away must not read as "none".
   */
  const [selected, setSelected] = useState<string>(() => (
    rows.length > 0 || history.length === 0 ? 'live' : String(history.length - 1)
  ))
  /**
   * Rule 3 from the header, applied WITHOUT stealing an explicit pick: only
   * move the reader when they are still on `live` AND live is empty AND
   * history has something. A reader who deliberately selected an older run
   * must not be yanked back to "最近一轮" the moment a manual run completes
   * (a new history entry bumps `history.length`); they can see the fresh run
   * by clicking the picker, and the empty-live jump still fires on return.
   */
  useEffect(() => {
    if (selected !== 'live') return
    if (rows.length > 0) return
    if (history.length > 0) setSelected(String(history.length - 1))
  }, [selected, rows.length, history.length])
  /** Escape and outside-click, the two ways any dialog on this host closes. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (panelRef.current?.contains(target) === true) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
    }
  }, [onClose])

  const shownRows = useMemo(() => {
    if (selected === 'live') return rows
    const run = history[Number(selected)]
    return run === undefined ? rows : run.details
  }, [selected, rows, history])

  /**
   * The run the header totals describe — ONLY when those totals actually
   * describe what is shown. On `live` with rows, the live snapshot has no
   * aggregate of its own and the newest ancestor is the right headline; on
   * `live` with NO rows, that ancestor's total (possibly a ×N-collapsed run)
   * next to an empty receipt is a number describing nothing visible, so the
   * headline is withheld rather than allowed to disagree with the body.
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

  const title = t?.('auto.details.title') ?? '领取详情'
  const whenText = lastAt === undefined
    ? (t?.('auto.details.noRun') ?? '还没有完成过领取。')
    : new Date(lastAt).toLocaleString()
  const totalCredit = headerRun?.totals?.credit ?? 0

  return (
    <div className="dsm-xdpool-autodetails-scrim">
      <style>{AUTO_LEDGER_CSS}</style>
      <div
        ref={panelRef}
        className="dsm-xdpool-autodetails"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* ── Receipt head: what ran, when, and the number that matters ── */}
        <div className="dsm-xdpool-ledger-head">
          <div className="dsm-xdpool-ledger-id">
            <span className="dsm-xdpool-ledger-eyebrow">{title}</span>
            <span className="dsm-xdpool-ledger-when">{whenText}</span>
          </div>
          {headerRun !== undefined && (
            <div className="dsm-xdpool-ledger-total" title={headerRun.result}>
              <span className="dsm-xdpool-ledger-total-num">
                {totalCredit > 0 ? `+${String(totalCredit)}` : String(totalCredit)}
              </span>
              <span className="dsm-xdpool-ledger-total-unit">{t?.('auto.details.creditUnit') ?? '积分'}</span>
            </div>
          )}
          <button
            type="button"
            className="dsm-xdpool-ledger-close"
            aria-label={t?.('auto.details.close') ?? '关闭'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* ── Toolbar: switch runs, or force a new pass ── */}
        <div className="dsm-xdpool-ledger-toolbar">
          <label className="dsm-xdpool-ledger-picker">
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
            className="dsm-xdpool-ledger-run"
            disabled={running}
            onClick={onRunNow}
          >
            {running
              ? (t?.('auto.details.running') ?? '领取中…')
              : (t?.('auto.details.runNow') ?? '立即领取')}
          </button>
        </div>

        {/* ── The receipt body ── */}
        <div className="dsm-xdpool-ledger-body">
          {shownRows.length === 0 && (
            <p className="dsm-xdpool-ledger-empty">
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
              <section key={group} className="dsm-xdpool-ledger-group" data-tone={group}>
                <h4 className="dsm-xdpool-ledger-grouphead">
                  <span className="dsm-xdpool-ledger-dot" aria-hidden="true" />
                  <span className="dsm-xdpool-ledger-grouplabel">{label}</span>
                  <span className="dsm-xdpool-ledger-rule" aria-hidden="true" />
                  <span className="dsm-xdpool-ledger-count">{items.length}</span>
                </h4>
                <ul className="dsm-xdpool-ledger-rows">
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
                      <li key={`${row.provider}:${row.accountId ?? row.nickname ?? 'provider'}:${String(index)}`} className="dsm-xdpool-ledger-line">
                        <div className="dsm-xdpool-ledger-row">
                          <span className="dsm-xdpool-ledger-who" title={row.accountId ?? who}>{who}</span>
                          <span className="dsm-xdpool-ledger-leader" aria-hidden="true" />
                          {amount !== ''
                            ? <span className="dsm-xdpool-ledger-amount">{amount}</span>
                            : <span className="dsm-xdpool-ledger-namount">{statusLabel(row.status, t)}</span>}
                        </div>
                        <div className="dsm-xdpool-ledger-why">
                          {reason}
                          {row.code !== undefined && row.code !== 0 && (
                            <span className="dsm-xdpool-ledger-code"> · code {String(row.code)}</span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * Self-contained ledger styles. Tokens come from the host theme when present
 * and fall back to the values the rest of this card ships with.
 */
const AUTO_LEDGER_CSS = `
.dsm-xdpool-autodetails-scrim {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(6, 8, 12, 0.62);
  backdrop-filter: blur(3px);
  animation: xd-scrim-in 140ms ease-out;
}
.dsm-xdpool-autodetails {
  width: min(640px, 100%); max-height: min(76vh, 760px);
  display: flex; flex-direction: column;
  border-radius: 16px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #1c1f27);
  border: 1px solid var(--dsw-alias-border-l2, #323846);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  color: var(--dsw-alias-label-primary, #e8eaf0);
  font-size: 13px;
  animation: xd-ledger-in 160ms cubic-bezier(0.32, 0.72, 0, 1);
}
@keyframes xd-scrim-in { from { opacity: 0; } }
@keyframes xd-ledger-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } }
@media (prefers-reduced-motion: reduce) {
  .dsm-xdpool-autodetails-scrim, .dsm-xdpool-autodetails { animation: none; }
}
.dsm-xdpool-ledger-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #323846);
}
.dsm-xdpool-ledger-id { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsm-xdpool-ledger-eyebrow {
  font-size: 11px; font-weight: 700; letter-spacing: 0.14em;
  color: var(--dsw-alias-label-secondary, #98a0b3);
}
.dsm-xdpool-ledger-when { font-size: 12px; color: var(--dsw-alias-label-tertiary, #7d8496); }
.dsm-xdpool-ledger-total {
  margin-left: auto; display: flex; align-items: baseline; gap: 6px;
  padding: 4px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #48c784) 14%, transparent);
}
.dsm-xdpool-ledger-total-num {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 22px; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary, #48c784);
}
.dsm-xdpool-ledger-total-unit { font-size: 11px; color: var(--dsw-alias-state-success-primary, #48c784); opacity: 0.85; }
.dsm-xdpool-ledger-close {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 22px; line-height: 1; padding: 0 2px; opacity: 0.65; align-self: flex-start;
}
.dsm-xdpool-ledger-close:hover { opacity: 1; }
.dsm-xdpool-ledger-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2, #323846);
}
.dsm-xdpool-ledger-picker { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #98a0b3); }
.dsm-xdpool-ledger-picker select {
  max-width: 250px; padding: 4px 9px; border-radius: 7px; font-size: 11.5px;
  background: var(--dsw-alias-bg-layer-3, #22252e); color: inherit;
  border: 1px solid var(--dsw-alias-border-l2, #323846);
}
.dsm-xdpool-ledger-picker select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #5686fe); outline-offset: 1px; }
.dsm-xdpool-ledger-run {
  margin-left: auto; padding: 5px 14px; border-radius: 8px; cursor: pointer;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
  border: 1px solid var(--dsw-alias-state-success-primary, #48c784);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #48c784) 15%, transparent);
  color: var(--dsw-alias-state-success-primary, #48c784);
}
.dsm-xdpool-ledger-run:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #48c784) 28%, transparent); }
.dsm-xdpool-ledger-run:disabled { opacity: 0.55; cursor: default; }
.dsm-xdpool-ledger-body { overflow: auto; padding: 6px 20px 20px; }
.dsm-xdpool-ledger-empty { opacity: 0.7; padding: 26px 0; text-align: center; }
.dsm-xdpool-ledger-group { margin-top: 16px; }
.dsm-xdpool-ledger-grouphead {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 8px; font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: none;
  color: var(--dsw-alias-label-secondary, #98a0b3);
}
.dsm-xdpool-ledger-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); flex: none; }
.dsm-xdpool-ledger-group[data-tone="success"] .dsm-xdpool-ledger-dot { background: var(--dsw-alias-state-success-primary, #48c784); }
.dsm-xdpool-ledger-group[data-tone="already"] .dsm-xdpool-ledger-dot { background: var(--dsw-alias-state-business-primary, #7896dc); }
.dsm-xdpool-ledger-group[data-tone="failed"] .dsm-xdpool-ledger-dot { background: var(--dsw-alias-state-error-primary, #e65a5a); }
.dsm-xdpool-ledger-rule { flex: 1; border-top: 1px solid var(--dsw-alias-border-l2, #323846); opacity: 0.6; }
.dsm-xdpool-ledger-count {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px; min-width: 22px; text-align: center;
  padding: 1px 7px; border-radius: 9px;
  background: rgba(255, 255, 255, 0.07);
}
.dsm-xdpool-ledger-rows { list-style: none; margin: 0; padding: 0; }
.dsm-xdpool-ledger-line { padding: 7px 2px 8px; border-bottom: 1px dashed var(--dsw-alias-border-l2, #323846); }
.dsm-xdpool-ledger-line:last-child { border-bottom: 0; }
.dsm-xdpool-ledger-row { display: flex; align-items: baseline; gap: 10px; }
.dsm-xdpool-ledger-who { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.dsm-xdpool-ledger-leader {
  flex: 1; min-width: 24px;
  border-bottom: 1px dotted var(--dsw-alias-label-tertiary, #4a5162);
  transform: translateY(-3px);
}
.dsm-xdpool-ledger-amount {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 13px; font-weight: 700; white-space: nowrap;
  color: var(--dsw-alias-state-success-primary, #48c784);
}
.dsm-xdpool-ledger-namount { font-size: 11px; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #7d8496); }
.dsm-xdpool-ledger-why {
  margin-top: 3px; padding-left: 2px;
  font-size: 11.5px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #98a0b3);
  overflow-wrap: anywhere; white-space: pre-wrap;
}
.dsm-xdpool-ledger-group[data-tone="failed"] .dsm-xdpool-ledger-why {
  color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e65a5a) 82%, var(--dsw-alias-label-primary, #e8eaf0));
}
.dsm-xdpool-ledger-code { opacity: 0.75; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
`
