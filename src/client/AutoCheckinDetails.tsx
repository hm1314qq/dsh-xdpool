/**
 * The auto-check-in claim ledger.
 *
 * The reader opens this to answer one question: who collected what, who
 * failed, and why. So the shape borrows from a receipt: a headline total, one
 * line per account with the vendor's own amount, and the upstream's failure
 * message quoted underneath.
 *
 * IT IS BUILT FROM THE 3.0 DIALOG VOCABULARY, NOT ITS OWN STYLESHEET
 *
 * This component used to ship a private `.dsm-xdpool-ledger-*` sheet injected
 * by a `<style>` tag. 3.0 consolidated every page onto one injected sheet and a
 * single class vocabulary (`.pick*` for a dialog, `.btn`, `.pill`, `.hint`), and
 * `tests/bundle-contract.test.ts` now fails a component that injects its own —
 * rightly: a second stylesheet is a second set of tokens to keep in sync.
 *
 * So the markup reuses the same skeleton the aggregate page's model picker
 * uses (scrim → `.pick` → `.pick-head` → `.pick-tools` → scrolling body →
 * `.pick-foot`), and the only rules that are genuinely new — a dotted leader
 * between the account and its amount, the group tone — live in `styles.ts`
 * under `.ledger-*`, which is part of that one sheet.
 *
 * Behavioural notes learned the hard way:
 *
 *  1. The dialog owns no fetching. The parent refreshes on open and after a
 *     manual run, so there is exactly one source of truth.
 *  2. When the live snapshot has no rows but history does, the picker defaults
 *     to the newest run — "empty" should never be the first thing a reader
 *     sees when data exists one click away.
 *  3. An explicit pick is never stolen: the auto-jump fires only while the
 *     reader is still on `live` AND live is empty.
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
  /*
    工具条上的时间描述「正在看的这一轮」，不是全局的 lastAt —— 翻到历史轮次时
    两者会对不上（00:43 的 lastAt 配着 22:42 的轮次，读起来像两张单据）。
  */
  const shownAt = selected === 'live'
    ? lastAt
    : (history[Number(selected)]?.at ?? lastAt)
  const whenText = shownAt === undefined
    ? (t?.('auto.details.noRun') ?? '还没有完成过领取。')
    : new Date(shownAt).toLocaleString()
  const totalCredit = headerRun?.totals?.credit ?? 0
  const totalAccounts = shownRows.length

  return (
    /*
      覆盖层与聚合页的模型选择器同构：固定铺满 + oklch 遮罩，点击遮罩关闭。
      用 role="presentation" 而不是 dialog —— 遮罩本身不是可聚焦的对话框。
    */
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--s5)',
        background: 'oklch(0% 0 0 / 0.45)',
      }}
    >
      <div
        ref={panelRef}
        className="pick"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        /*
          高度必须交给 .pick 那份样式表（height: 560px），这里只限制上限。之前在这里写
          height: 'auto'，把骨架的确定高度覆盖掉 —— flex:1 1 0 的列表在高度不确定的
          容器里被压成 0，明细全部被 overflow:hidden 裁掉，弹窗看起来是空的。
        */
        style={{ maxHeight: 'calc(100vh - 48px)', width: 'min(640px, 100%)' }}
        onClick={event => { event.stopPropagation() }}
      >
        {/* ── Head: what ran, when, and the number that matters ── */}
        <div className="pick-head">
          <span className="pick-title">{title}</span>
          {/*
            总额只在它真的描述下面的行时才出现（见 headerRun 的注释）。
            单位跟在数字后面，和账号行的单位是同一个词。
          */}
          {headerRun === undefined ? null : (
            <span className="pick-sum" title={headerRun.result}>
              <b>{totalCredit > 0 ? `+${String(totalCredit)}` : String(totalCredit)}</b>
              {' '}{t?.('auto.details.creditUnit') ?? '积分'}
            </span>
          )}
          <button
            type="button"
            className="pick-close"
            aria-label={t?.('auto.details.close') ?? '关闭'}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* ── Toolbar: switch runs, or force a new pass ── */}
        <div className="pick-tools">
          <span className="pick-sum">{whenText}</span>
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
            className="tiny tiny-primary"
            style={{ marginLeft: 'auto' }}
            disabled={running}
            onClick={onRunNow}
          >
            {running
              ? (t?.('auto.details.running') ?? '领取中…')
              : (t?.('auto.details.runNow') ?? '立即领取')}
          </button>
        </div>

        {/* ── The receipt body ── */}
        <div className="pick-list">
          {/*
            调度器那句汇总（「8 个渠道：4 个账号领取成功（+700 积分）…」）放在收据
            正文最上面：总额在标题里，这句解释总额是怎么来的。
          */}
          {headerRun !== undefined && headerRun.result !== '' && (
            <p className="hint" style={{ margin: '0 0 var(--s2)' }}>
              {headerRun.result}
            </p>
          )}
          {totalAccounts === 0 && (
            <p className="hint" style={{ margin: 'var(--s2)' }}>
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
              /*
                分组标题用 .sec-head 那套排版（衬线标题 + 右侧计数），
                data-tone 决定小圆点的颜色 —— 与渠道卡的 pill 同一套语义。
              */
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
        </div>
      </div>
    </div>
  )
}
