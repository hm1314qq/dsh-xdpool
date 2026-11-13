/**
 * Channel-pack daily auto check-in: it must run on EVERY day, not once per host
 * process, and a failed account must not be abandoned for the rest of the day.
 *
 * The field report was "自动领取积分失效了" while `auto-checkin.json` showed a
 * successful +900 claim at 10:13 that same morning. Two independent defects in
 * `createAutoCheckin` explain it:
 *
 *   1. `start()` installed a single 30-second `setTimeout`. There was no
 *      `setInterval` and no tomorrow timer: with DSH left running, the second
 *      day's claim simply never fired. Only a full host restart (or manually
 *      toggling the switch) woke it again.
 *   2. `shouldMarkToday()` returned `coversToday > 0`, so ONE successful
 *      account wrote `lastDate = today` and every account that FAILED in that
 *      same pass was silently dropped — with no recurring pass to retry them.
 *
 * `pack.js` is an external build artifact and cannot be imported, so these are
 * source-shape assertions, same as `release-267-regressions.test.ts`. They pin
 * the behaviour that matters; `tools/patch-pack-auto-checkin.mjs` is the
 * idempotent patch that produced it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

describe('auto check-in runs on a recurring timer (#cross-day)', () => {
  it('installs a repeating timer in addition to the one-shot mount delay', () => {
    expect(pack).toContain('defaultIntervalSchedule')
    expect(pack).toMatch(/function defaultIntervalSchedule\(fn, ms\) \{[\s\S]*?setInterval\(fn, ms\)/u)
    expect(pack).toContain('recurring = (deps.intervalSchedule ?? defaultIntervalSchedule)(fire, intervalMs);')
  })

  it('unrefs the interval so it cannot hold the host process open', () => {
    const body = pack.match(/function defaultIntervalSchedule\(fn, ms\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''
    expect(body).toContain('timer.unref?.()')
  })

  it('cancels BOTH timers on stop()', () => {
    const stop = pack.match(/    stop\(\) \{([\s\S]*?)\n    \},/u)?.[1] ?? ''
    expect(stop).toContain('pending?.cancel()')
    expect(stop).toContain('recurring?.cancel()')
    expect(stop).toContain('recurring = null')
  })

  it('guards against a duplicate start() while the recurring timer is live', () => {
    expect(pack).toContain('if (pending !== null || recurring !== null) return;')
  })

  it('keeps the same-day guard so repeat passes never double-collect', () => {
    // The recurring tick is only useful because the scheduled path is idempotent.
    // `runNow(force)` skips ONLY this gate; runIfDue still passes force=false.
    expect(pack).toContain('if (!force && doc.lastDate !== "" && doc.lastDate === today()) return Promise.resolve();')
    expect(pack).toContain('return startRun(false);')
    // And an upstream "already claimed" outcome is counted, not re-claimed.
    expect(pack).toContain('summary.alreadyClaimed += 1;')
  })

  it('exposes an interval override alongside the existing delay override', () => {
    expect(pack).toContain('DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS')
    expect(pack).toContain('AUTO_CHECKIN_INTERVAL_MS = 36e5')
    expect(pack).toContain('DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS')
  })
})

describe('a failed pass does not close the day (#retry)', () => {
  it('requires a clean pass before writing lastDate', () => {
    // The retry-policy patch made shouldMarkToday take the RETRYABLE count: a
    // permanent failure (auth refusal, no API, ended promotion) must not keep
    // the day open, or one broken account re-runs every channel every hour.
    expect(pack).toMatch(
      /function shouldMarkToday\(totals, retryableFailures\) \{\s*if \(totals\.coversToday <= 0\) return false;\s*if \(totals\.errors > 0\) return false;\s*return \(retryableFailures \?\? totals\.failed\) === 0;\s*\}/u,
    )
  })

  it('classifies permanent failures so they stop being retried', () => {
    expect(pack).toContain('var PERMANENT_FAILURE_PATTERNS = [')
    expect(pack).toContain('function isRetryableFailure(row)')
    expect(pack).toContain('function retryableFailureCount(rows)')
    // Auth / risk-control business codes are permanent even with a vague message.
    expect(pack).toContain('if (row.code === 1001 || row.code === 3012) return false;')
    expect(pack).toContain('if (row.code === 401 || row.code === 403) return false;')
    // An unknown error stays retryable: giving up wrongly is the worse failure.
    expect(pack).toMatch(/if \(text === ""\) return true;/u)
  })

  it('passes the retryable count into the gate', () => {
    expect(pack).toContain('const retryable = retryableFailureCount(details);')
    expect(pack).toContain('if (!shouldMarkToday(totals, retryable)) {')
  })

  it('still requires at least one collected account', () => {
    // An all-failure pass must not mark today either — otherwise a dead upstream
    // would permanently suppress the retry we just enabled.
    expect(pack).toContain('if (totals.coversToday <= 0) return false;')
  })

  it('reports failed accounts in the run summary', () => {
    expect(pack).toContain('if (totals.failed > 0) parts.push(')
  })
})
