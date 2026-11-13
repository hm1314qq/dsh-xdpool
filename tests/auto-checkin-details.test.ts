/**
 * The claim-details dialog is only as good as the data behind it.
 *
 * Two halves are pinned here:
 *   - the vendored pack records and returns a per-account breakdown (source
 *     assertions, because pack.js is a build artifact that cannot be imported);
 *   - the client parser survives an old pack, a missing `details` field and
 *     dirty rows without losing the switch state.
 *
 * The field that matters most is `reason`: it is the upstream's own message and
 * the only place that says WHY an account failed. It must survive both the
 * pack-side sanitizer and the client-side shape check.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { autoCheckinFrom, type ChannelRpcEnvelope } from '../src/client/channel-rpc.ts'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

/** Wrap an `autoCheckin` state object the way the RPC envelope does. */
function envelope(autoCheckin: unknown): ChannelRpcEnvelope {
  return { ok: true, value: { autoCheckin } } as unknown as ChannelRpcEnvelope
}

describe('pack: per-account details are recorded and exposed', () => {
  it('adds a details field to the persisted document and its sanitizer', () => {
    expect(pack).toContain('details: []')
    expect(pack).toContain('function sanitizeDetails(raw)')
    expect(pack).toContain('details: sanitizeDetails(record.details)')
    expect(pack).toContain('details: doc.details ?? []')
  })

  it('caps the rows so many accounts cannot grow the file without bound', () => {
    expect(pack).toContain('MAX_DETAIL_ENTRIES = 200')
    expect(pack).toContain('details: details.slice(0, MAX_DETAIL_ENTRIES)')
  })

  it('flattens each claim result into rows, keeping the upstream message', () => {
    expect(pack).toContain('function autoCheckinDetailRows(provider, result)')
    expect(pack).toContain('outcome?.message')
    expect(pack).toContain('outcome.credit')
    expect(pack).toContain('outcome.code')
  })

  it('labels provider-level outcomes separately from account failures', () => {
    expect(pack).toContain('status: "skipped"')
    expect(pack).toContain('status: "unsupported"')
    expect(pack).toContain('status: "none"')
  })

  it('persists details AND history even when a failed pass does not close the day', () => {
    // shouldMarkToday() returns false on a retryable failure, and performRun()
    // used to `return` BEFORE the doc write — losing the breakdown on exactly
    // the runs the user most wants to inspect.
    const early = pack.indexOf('if (!shouldMarkToday(totals, retryable)) {')
    expect(early).toBeGreaterThan(-1)
    const detailsWrite = pack.indexOf('details: details.slice(0, MAX_DETAIL_ENTRIES),', early)
    const historyWrite = pack.indexOf('appendHistory(doc.history,', early)
    // The branch's own closing `return;` is the first one AFTER the doc payload.
    const ret = pack.indexOf('      return;', historyWrite)
    expect(detailsWrite).toBeGreaterThan(early)
    expect(historyWrite).toBeGreaterThan(early)
    expect(detailsWrite).toBeLessThan(ret)
    expect(historyWrite).toBeLessThan(ret)
  })

  it('returns details and history from state(), which usage.autoCheckin forwards', () => {
    expect(pack).toContain('details: (doc.details ?? []).map((entry) => ({ ...entry }))')
    expect(pack).toContain('history: (doc.history ?? []).map')
  })
})

describe('pack: rolling 30-day run history', () => {
  it('bounds the window and the entry count independently', () => {
    expect(pack).toContain('MAX_HISTORY_DAYS = 30')
    expect(pack).toContain('MAX_HISTORY_ENTRIES = 120')
    expect(pack).toContain('HISTORY_WINDOW_MS = MAX_HISTORY_DAYS * 24 * 3600 * 1000')
    expect(pack).toContain('record.at < cutoff')
    expect(pack).toContain('kept.slice(-MAX_HISTORY_ENTRIES)')
  })

  it('de-duplicates by run timestamp and keeps every retry', () => {
    expect(pack).toContain('if (seen.has(record.at)) continue;')
    expect(pack).toContain('row.at !== entry.at')
  })

  it('collapses a repeat of the PREVIOUS run instead of appending a clone', () => {
    // Three manual clicks produced three byte-identical entries in the field,
    // which would consume the 120-entry cap in days.
    expect(pack).toContain('function sameHistoryRun(a, b)')
    expect(pack).toContain('if (last !== void 0 && sameHistoryRun(last, entry)) {')
    expect(pack).toContain('runs: (typeof last.runs === "number" ? last.runs : 1) + 1')
    // The counter must survive a reload, or it resets to 1 every time.
    expect(pack).toContain('? { runs: Math.floor(record.runs) }')
  })

  it('compares what the dialog SHOWS, not the drifting account id', () => {
    // Measured: TRAE re-minted `trae-feda3732` -> `trae-c476bfb4` for the same
    // nickname and the same "今天已签到", so every click looked like a new run.
    expect(pack).toContain('function historyRowKey(row)')
    expect(pack).toContain('function historyDetailsKey(details)')
    expect(pack).toContain('historyDetailsKey(a.details) === historyDetailsKey(b.details)')
    // The raw whole-array comparison is what caused the miss.
    expect(pack).not.toContain('&& JSON.stringify(a.details ?? []) === JSON.stringify(b.details ?? []);')
    // The key must not READ accountId, or the drift comes straight back.
    // (The comment above the key mentions the word on purpose, so assert on the
    // code, not the prose.)
    const key = pack.match(/function historyRowKey\(row\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''
    expect(key).not.toMatch(/row\.accountId/u)
    // Ordering must be normalised: channel iteration order is not an outcome.
    expect(pack).toContain('details.map(historyRowKey).sort()')
  })

  it('sanitizes history through the same detail whitelist', () => {
    expect(pack).toContain('function sanitizeHistory(raw, nowMs = Date.now())')
    expect(pack).toContain('details: sanitizeDetails(record.details)')
    expect(pack).toContain('history: sanitizeHistory(record.history, Date.now())')
    expect(pack).toContain('history: doc.history ?? []')
  })

  it('appends on BOTH the failed and the successful end path', () => {
    const hits = [...pack.matchAll(/appendHistory\(doc\.history/gu)]
    expect(hits).toHaveLength(2)
  })

  it('records one shared timestamp for lastAt and the history entry', () => {
    expect(pack).toContain('const runAt = now()')
    expect(pack).toContain('lastAt: runAt,')
  })
})

describe('pack: explicit manual claim', () => {
  it('exposes a force runner that skips only the same-day gate', () => {
    expect(pack).toContain('function startRun(force)')
    expect(pack).toContain('if (!force && doc.lastDate !== "" && doc.lastDate === today()) return Promise.resolve();')
    expect(pack).toContain('if (!doc.enabled) return Promise.resolve();')
    expect(pack).toContain('async runNow()')
    expect(pack).toContain('return startRun(false);')
  })

  it('keeps the in-flight guard so a manual click cannot overlap a pass', () => {
    expect(pack).toContain('if (inflight !== null) return inflight;')
  })

  it('wires a `run: true` RPC branch that returns the fresh state', () => {
    expect(pack).toContain('if (req.run === true)')
    expect(pack).toContain('autoCheckin: await autoCheckin.runNow()')
  })
})

describe('client: autoCheckinFrom tolerates old and dirty payloads', () => {
  it('parses a full breakdown with reasons and amounts', () => {
    const state = autoCheckinFrom(envelope({
      enabled: true,
      ranToday: true,
      running: false,
      lastResult: '7 个渠道：6 个账号领取成功（+900积分），2 个失败',
      lastAt: 1794536028605,
      channels: [{ provider: 'buddy', text: '1 个 +100积分' }],
      details: [
        { provider: 'buddy', status: 'claimed', accountId: 'a1', nickname: '普通人', amount: 100 },
        { provider: 'lobsterai', status: 'failed', accountId: 'b2', nickname: '杨某', reason: '轮询被拒绝（HTTP 403）', code: 403 },
        { provider: 'zcode', status: 'skipped', reason: 'manual-checkin-required' },
      ],
    }))
    expect(state?.enabled).toBe(true)
    expect(state?.lastAt).toBe(1794536028605)
    expect(state?.details).toHaveLength(3)
    expect(state?.details[0]).toMatchObject({ provider: 'buddy', status: 'claimed', nickname: '普通人', amount: 100 })
    expect(state?.details[1]).toMatchObject({ status: 'failed', reason: '轮询被拒绝（HTTP 403）', code: 403 })
    expect(state?.details[2]?.status).toBe('skipped')
  })

  it('an old pack with no details/history still yields a working switch', () => {
    const state = autoCheckinFrom(envelope({ enabled: true, ranToday: false, running: false, channels: [] }))
    expect(state?.enabled).toBe(true)
    expect(state?.details).toEqual([])
    expect(state?.history).toEqual([])
    expect(state?.channels).toEqual([])
  })

  it('drops malformed rows but keeps the good ones', () => {
    const state = autoCheckinFrom(envelope({
      enabled: true,
      details: [
        null,
        'nope',
        { provider: 'buddy' },                       // no status
        { status: 'failed' },                        // no provider
        { provider: 'trae', status: 'failed', reason: 'timeout', code: -1 },
        { provider: 'qoder', status: 'claimed', amount: '100' }, // amount not a number
      ],
    }))
    expect(state?.details).toHaveLength(2)
    expect(state?.details[0]).toMatchObject({ provider: 'trae', reason: 'timeout', code: -1 })
    expect(state?.details[1]).toEqual({ provider: 'qoder', status: 'claimed' })
  })

  it('keeps an unknown status rather than discarding the row', () => {
    const state = autoCheckinFrom(envelope({ enabled: true, details: [{ provider: 'x', status: 'new-kind', reason: 'upstream changed' }] }))
    expect(state?.details[0]).toMatchObject({ status: 'new-kind', reason: 'upstream changed' })
  })

  it('parses the rolling history with each run\'s own details', () => {
    const state = autoCheckinFrom(envelope({
      enabled: true,
      details: [{ provider: 'buddy', status: 'claimed', amount: 100 }],
      history: [
        { at: 1794449628605, date: '2026-11-12', result: 'failed pass', totals: { claimed: 0, failed: 2, credit: 0 },
          details: [{ provider: 'trae', status: 'failed', reason: 'timeout' }] },
        { at: 1794536028605, date: '2026-11-13', result: 'clean pass', totals: { claimed: 6, failed: 0, credit: 900 },
          details: [{ provider: 'buddy', status: 'claimed', amount: 100 }] },
      ],
    }))
    expect(state?.history).toHaveLength(2)
    expect(state?.history[0]?.totals).toMatchObject({ failed: 2 })
    expect(state?.history[0]?.details[0]).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(state?.history[1]?.totals.credit).toBe(900)
  })

  it('drops history entries with no usable timestamp', () => {
    const state = autoCheckinFrom(envelope({
      enabled: true,
      history: [
        null,
        { date: '2026-11-13', result: 'no at' },
        { at: 'yesterday', result: 'bad at' },
        { at: 1794536028605, date: '2026-11-13', result: 'ok', totals: { credit: '900' }, details: 'nope' },
      ],
    }))
    expect(state?.history).toHaveLength(1)
    expect(state?.history[0]).toMatchObject({ at: 1794536028605, result: 'ok', totals: {}, details: [] })
  })

  it('keeps the collapse counter so the picker can show ×N', () => {
    const state = autoCheckinFrom(envelope({
      enabled: true,
      history: [
        { at: 1, date: '2026-11-13', result: 'r', details: [], runs: 3 },
        { at: 2, date: '2026-11-13', result: 'r', details: [] },
        { at: 3, date: '2026-11-13', result: 'r', details: [], runs: 0 },
        { at: 4, date: '2026-11-13', result: 'r', details: [], runs: 'two' },
      ],
    }))
    expect(state?.history[0]?.runs).toBe(3)
    // Absent / zero / non-numeric all read as "unique run" — undefined.
    expect(state?.history[1]?.runs).toBeUndefined()
    expect(state?.history[2]?.runs).toBeUndefined()
    expect(state?.history[3]?.runs).toBeUndefined()
  })
})
