/**
 * Behaviour-level check for the patched `createAutoCheckin`.
 *
 * `vitest` needs the repo's dev dependencies; this script needs only Node. It
 * extracts the patched functions straight out of `vendor/channel-pack/pack.js`
 * (so it always tests the real artifact, never a copy), supplies minimal
 * stand-ins for the pack's helpers, and drives a fake clock across a day
 * boundary. It proves the two fixes without loading the 3 MB bundle.
 *
 * Run: node tools/verify-auto-checkin.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The build artifact is CRLF on Windows; normalise so the extraction markers
// (written with \n) match on every platform. An optional argv[2] lets the same
// check run against an INSTALLED copy of pack.js (e.g. after importing into a
// DSH profile) instead of the working tree's build.
const packPath = process.argv[2] ?? new URL('../vendor/channel-pack/pack.js', import.meta.url)
const pack = readFileSync(packPath, 'utf8').replace(/\r\n/gu, '\n')

/** Pull one top-level function declaration out of the bundle by name. */
function extract(name, endMarker) {
  const start = pack.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`function ${name} not found`)
  const end = pack.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker for ${name} not found`)
  return pack.slice(start, end)
}

const source = [
  'const AUTO_CHECKIN_INTERVAL_MS = 36e5;',
  'const DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS = "DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS";',
  'const QODER_BILLING_UTC_OFFSET_MS = 8 * 3600 * 1000;',
  'function autoCheckinIntervalMs() { return AUTO_CHECKIN_INTERVAL_MS; }',
  'function autoCheckinDelayMs() { return 3e4; }',
  'function utc8DateString(nowMs = Date.now()) { return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10); }',
  'function emptyTotals2() { return { providers: 0, claimed: 0, totalCredit: 0, totalByUnit: { token: 0, credit: 0 }, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0, skipped: 0, errors: 0 }; }',
  'function isUnsupportedCheckin(m) { return m.includes("unsupported"); }',
  'const ZCODE = { id: "zcode" };',
  'function isAutoCheckinExcluded(p) { return p === ZCODE.id; }',
  'function formatClaimGains(u) { return `+${u.credit ?? 0}`; }',
  'function describeRun(t) { return `claimed=${t.claimed} failed=${t.failed} errors=${t.errors}`; }',
  'function describeChannel(s) { return `claimed=${s.claimed} already=${s.alreadyClaimed} failed=${s.failed}`; }',
  'function defaultSchedule(fn) { return { cancel() {}, fire: fn }; }',
  extract('shouldMarkToday', '\nfunction describeChannel'),
  // The retry-policy patch puts its constant + classifier just before
  // shouldMarkToday; pull the whole contiguous block in one go.
  (() => {
    const start = pack.indexOf('var PERMANENT_FAILURE_PATTERNS')
    const end = pack.indexOf('\nfunction shouldMarkToday')
    if (start === -1 || end === -1) throw new Error('retry-policy block not found')
    return pack.slice(start, end)
  })(),
  // One contiguous block: sanitizeDetails + the history constants/helpers,
  // ending just before sanitizeAutoCheckin. Pulling them together avoids
  // duplicating the shared tail between the two patches.
  extract('sanitizeDetails', '\nfunction sanitizeAutoCheckin'),
  // The details patch inserts its helper immediately before createAutoCheckin;
  // pull it in too, or a real performRun() would hit an undefined function.
  extract('autoCheckinDetailRows', '\nfunction createAutoCheckin'),
  extract('createAutoCheckin', '\n// [xdpool-local] auto-checkin: a repeating'),
  extract('defaultIntervalSchedule', '\n\nfunction defaultSchedule'),
  // MAX_DETAIL_ENTRIES and DATE_RE are declared BEFORE sanitizeDetails, so the
  // extracted block does not carry them. The history constants ARE inside it.
  'const MAX_DETAIL_ENTRIES = 200;',
  'const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;',
  'globalThis.__make = createAutoCheckin;',
  'globalThis.__shouldMarkToday = shouldMarkToday;',
  'globalThis.__rows = autoCheckinDetailRows;',
  'globalThis.__appendHistory = appendHistory;',
  'globalThis.__sanitizeHistory = sanitizeHistory;',
  'globalThis.__isRetryable = isRetryableFailure;',
  'globalThis.__sameHistoryRun = sameHistoryRun;',].join('\n')

const sandbox = { console, process, Date, Set, Promise, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Number, String, Array, Object }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

let failures = 0
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures += 1
}

const shouldMarkToday = sandbox.__shouldMarkToday

// ---------------------------------------------------------------- 1. shouldMarkToday
check('a clean pass closes the day', shouldMarkToday({ coversToday: 2, failed: 0, errors: 0 }) === true)
check('a retryable failure keeps the day open', shouldMarkToday({ coversToday: 2, failed: 1, errors: 0 }, 1) === false)
check('a PERMANENT-only failure closes the day', shouldMarkToday({ coversToday: 2, failed: 2, errors: 0 }, 0) === true)
check('a channel error keeps the day open', shouldMarkToday({ coversToday: 2, failed: 0, errors: 1 }, 0) === false)
check('an all-failure pass does NOT close the day', shouldMarkToday({ coversToday: 0, failed: 3, errors: 0 }, 0) === false)

// ---------------------------------------------------------------- 1b. failure classification
const retryable = sandbox.__isRetryable
check('an auth refusal is permanent', retryable({ status: 'failed', code: 1001, reason: "We're sorry, but we are not able to authenticate you." }) === false)
check('a risk-control code is permanent', retryable({ status: 'failed', code: 3012, reason: 'whatever' }) === false)
check('an ended promotion is permanent', retryable({ status: 'failed', code: -1, reason: '活动槽位查询失败' }) === false)
check('an unconfigured credential is permanent', retryable({ status: 'failed', reason: '凭据未配置' }) === false)
check('a timeout is retryable', retryable({ status: 'failed', code: -1, reason: 'fetch failed: ETIMEDOUT' }) === true)
check('a 502 is retryable', retryable({ status: 'failed', code: 502, reason: 'bad gateway' }) === true)
check('an unknown error is retryable (fail open)', retryable({ status: 'failed', reason: 'something new' }) === true)
check('a non-failed row is never counted', retryable({ status: 'claimed' }) === false)

// ---------------------------------------------------------------- fake clock + deps
let clockMs = Date.parse('2026-11-13T00:00:00Z') // = 08:00 Beijing on 11-13
let claimCalls = 0
let intervalFire = null
let oneShotFire = null
let intervalCount = 0
let stoppedInterval = false
const saved = []
let mode = 'fail' // fail -> retry-clean -> next-day

const deps = {
  now: () => clockMs,
  store: {
    load: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0 }),
    save: async (doc) => { saved.push({ ...doc }) },
  },
  listProviderIds: async () => ['buddy'],
  claim: async () => {
    claimCalls += 1
    if (mode === 'fail') {
      return { ok: true, value: {
        summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 1, coversToday: 2 },
        results: [
          { accountId: 'a1', nickname: '普通人', outcome: { kind: 'claimed', credit: 100 } },
          // RETRYABLE on purpose: this scenario must keep the day open.
          { accountId: 'a2', nickname: '杨某', outcome: { kind: 'failed', code: -1, message: 'fetch failed: ETIMEDOUT' } },
        ],
      } }
    }
    if (mode === 'fail-permanent') {
      return { ok: true, value: {
        summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 8, inactive: 0, failed: 2, coversToday: 8 },
        results: [
          { accountId: 'a1', nickname: 'lobster', outcome: { kind: 'failed', code: -1, message: '活动槽位查询失败' } },
          { accountId: 'a2', nickname: 'trae', outcome: { kind: 'failed', code: 1001, message: "We're sorry, but we are not able to authenticate you." } },
        ],
      } }
    }
    if (mode === 'retry-clean') {
      return { ok: true, value: {
        summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 2, inactive: 0, failed: 0, coversToday: 2 },
        results: [
          { accountId: 'a1', nickname: '普通人', outcome: { kind: 'already-claimed', message: '今天已签到' } },
          { accountId: 'a2', nickname: '杨某', outcome: { kind: 'claimed', credit: 50 } },
        ],
      } }
    }
    return { ok: true, value: {
      summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 1 },
      results: [{ accountId: 'a1', nickname: '普通人', outcome: { kind: 'claimed', credit: 100 } }],
    } }
  },
  warn: () => {},
  delayMs: 0, // fire the first pass synchronously inside start()
  intervalSchedule: (fn) => { intervalCount += 1; intervalFire = fn; return { cancel() { stoppedInterval = true } } },
  schedule: (fn) => { oneShotFire = fn; return { cancel() {} } },
}

const checkin = sandbox.__make(deps)

// ---------------------------------------------------------------- 2. recurring timer
checkin.start()
check('start() installs exactly one recurring timer', intervalCount === 1)
check('start() is idempotent', (checkin.start(), intervalCount === 1))

// ---------------------------------------------------------------- 3. failed pass leaves lastDate empty
// `fire()` starts an async pass; give it a tick to reach the first claim.
await new Promise(r => setTimeout(r, 5))
check('the one-shot delay fired a claim (delayMs=0)', claimCalls === 1)
check('failed pass did NOT persist a lastDate', saved.length === 0 || saved.at(-1).lastDate === '')
check('ranToday is still false after a failed pass', checkin.state().ranToday === false)
// The breakdown must survive a FAILED pass — that is when the reasons matter.
const failedDoc = saved.at(-1)
check('failed pass still persisted per-account details', Array.isArray(failedDoc?.details) && failedDoc.details.length === 2)
check('successful account row carries its amount', failedDoc?.details?.[0]?.status === 'claimed' && failedDoc.details[0].amount === 100)
check('failed account row keeps the upstream reason', failedDoc?.details?.[1]?.status === 'failed' && failedDoc.details[1].reason === 'fetch failed: ETIMEDOUT')
check('failed account row keeps the error code', failedDoc?.details?.[1]?.code === -1)
check('details are exposed through state()', checkin.state().details.length === 2)
// A failed pass is a run of its own: it must be in history, with its reasons.
check('failed pass appended ONE history entry', checkin.state().history.length === 1)
check('history entry carries the run summary', checkin.state().history[0]?.result.includes('failed=1') === true)
check('history entry keeps that run\'s per-account details', checkin.state().history[0]?.details.length === 2)

// ---------------------------------------------------------------- 4. recurring tick retries the SAME day
mode = 'retry-clean'
// Advance the fake clock: two real passes are at least an hour apart, and the
// history de-duplicates by timestamp. Same-ms retries are (correctly) merged.
clockMs = Date.parse('2026-11-13T01:00:00Z')
intervalFire()
await new Promise(r => setTimeout(r, 5))
check('recurring tick retried the failed pass', claimCalls === 2)
check('clean retry finally closed the day', checkin.state().ranToday === true)
check('clean retry persisted lastDate', saved.at(-1)?.lastDate === '2026-11-13')
check('clean retry replaced the details with the new pass', saved.at(-1)?.details?.[0]?.status === 'already-claimed')
check('every retry is its OWN history entry', checkin.state().history.length === 2)
check('history is oldest-first', checkin.state().history[0].at < checkin.state().history[1].at)
check('the two history entries have different breakdowns',
  checkin.state().history[0].details[0].status === 'claimed'
  && checkin.state().history[1].details[0].status === 'already-claimed')

// ---------------------------------------------------------------- 4b. detail flattener edge cases
const rows = sandbox.__rows
check('an ok:false envelope becomes one failed row with its reason',
  rows('raccoon', { ok: false, error: { message: '不支持每日签到' } })[0]?.status === 'failed'
  && rows('raccoon', { ok: false, error: { message: '不支持每日签到' } })[0]?.reason === '不支持每日签到')
check('an ok:true envelope with no results becomes one "none" row',
  rows('buddy', { ok: true, value: {} })[0]?.status === 'none')
check('a thrown claim is represented as a failed row',
  rows('trae', { ok: false, error: { message: 'claim-call-failed' } })[0]?.reason === 'claim-call-failed')

// ---------------------------------------------------------------- 4c. appendHistory bounds
const append = sandbox.__appendHistory
const clean = sandbox.__sanitizeHistory
const t0 = Date.parse('2026-11-13T00:00:00Z')
const entry = (at) => ({ at, date: '2026-11-13', result: 'r', totals: {}, details: [] })
check('appendHistory de-duplicates by `at`',
  append([entry(t0)], entry(t0), t0).length === 1)
check('appendHistory drops entries outside the 30-day window',
  append([entry(t0 - 31 * 86400000)], entry(t0), t0).length === 1)
check('appendHistory caps at 120 entries',
  append(Array.from({ length: 200 }, (_, i) => entry(t0 + i * 1000)), entry(t0 + 999999), t0 + 999999).length === 120)
// Consecutive IDENTICAL runs collapse into one row with a counter.
{
  const same = (at) => ({ at, date: '2026-11-13', result: 'r', totals: { failed: 2 }, details: [] })
  const once = append([same(t0)], same(t0 + 60000), t0 + 60000)
  check('an identical consecutive run collapses to one entry', once.length === 1)
  check('the collapsed entry counts its runs', once[0].runs === 2)
  check('the collapsed entry moves its stamp forward', once[0].at === t0 + 60000)
  const differing = append(once, { at: t0 + 120000, date: '2026-11-13', result: 'r', totals: { failed: 0 }, details: [] }, t0 + 120000)
  check('a DIFFERENT run is still its own entry', differing.length === 2)
}
// The de-duplication key must ignore the internal account id (it drifts) while
// still noticing a real outcome change.
{
  const same = sandbox.__sameHistoryRun
  const base = {
    result: 'r', totals: { failed: 1 },
    details: [{ provider: 'trae', nickname: '135******84', status: 'failed', code: 1001, reason: 'auth' }],
  }
  const driftedId = {
    ...base,
    details: [{ provider: 'trae', nickname: '135******84', accountId: 'trae-c476bfb4', status: 'failed', code: 1001, reason: 'auth' }],
  }
  check('an account-id drift alone is NOT a new run', same(base, driftedId) === true)
  const reordered = {
    ...base,
    details: [
      { provider: 'zcode', nickname: '', status: 'skipped' },
      { provider: 'trae', nickname: '135******84', status: 'failed', code: 1001, reason: 'auth' },
    ],
  }
  const reorderedSame = {
    ...base,
    details: [
      { provider: 'trae', nickname: '135******84', status: 'failed', code: 1001, reason: 'auth' },
      { provider: 'zcode', nickname: '', status: 'skipped' },
    ],
  }
  check('channel iteration order is NOT a new run', same(reordered, reorderedSame) === true)
  const changed = {
    ...base,
    details: [{ provider: 'trae', nickname: '135******84', status: 'claimed', amount: 100 }],
  }
  check('a real status change IS a new run', same(base, changed) === false)
  const addedAccount = {
    ...base,
    details: [
      ...base.details,
      { provider: 'trae', nickname: 'other', status: 'failed', code: 1001, reason: 'auth' },
    ],
  }
  check('an added account IS a new run', same(base, addedAccount) === false)
}
check('sanitizeHistory drops a malformed row but keeps a good one',
  clean([null, { at: 'bad' }, entry(t0)], t0).length === 1)
check('sanitizeHistory reuses the details whitelist',
  clean([{ ...entry(t0), details: [{ provider: 'x', status: 'failed', reason: 'r' }, { nope: 1 }] }], t0)[0].details.length === 1)

// ---------------------------------------------------------------- 5. another tick the SAME day is a no-op
const beforeSameDay = claimCalls
intervalFire()
await new Promise(r => setTimeout(r, 5))
check('a second tick the same day does NOT re-claim', claimCalls === beforeSameDay)

// ---------------------------------------------------------------- 5b. runNow() forces a pass on the SAME day
mode = 'next-day'
clockMs = Date.parse('2026-11-13T02:00:00Z')
const beforeForce = claimCalls
const forced = await checkin.runNow()
await new Promise(r => setTimeout(r, 5))
check('runNow() DOES re-claim even though today is already covered', claimCalls === beforeForce + 1)
check('runNow() returns the fresh state', forced.history.length === 3)
check('runNow() appended a third history entry', checkin.state().history.length === 3)
// The enabled switch still wins over force.
deps.store.load = () => ({ enabled: false, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0, details: [], history: [] })
const disabled = sandbox.__make(deps)
const beforeDisabled = claimCalls
await disabled.runNow()
check('runNow() still refuses when the automation is switched OFF', claimCalls === beforeDisabled)

// ---------------------------------------------------------------- 6. cross-day tick claims the NEXT day
mode = 'next-day'
clockMs = Date.parse('2026-11-13T16:00:00Z') // = 00:00 Beijing on 11-14
const beforeNextDay = claimCalls
intervalFire()
await new Promise(r => setTimeout(r, 5))
check('a tick after midnight DOES claim the new day', claimCalls === beforeNextDay + 1)
check('next-day pass persisted the new lastDate', saved.at(-1)?.lastDate === '2026-11-14')
check('ranToday reflects the new day', checkin.state().ranToday === true)

// ---------------------------------------------------------------- 8. permanent-only failure closes the day
// This is the field case: lobsterai ("活动槽位查询失败") + trae (code 1001).
// Neither fixes itself by retrying, so the day must close and the recurring
// timer must stop re-running all thirteen channels every hour.
{
  const permSaved = []
  const permDeps = {
    now: () => clockMs,
    store: {
      load: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0, details: [], history: [] }),
      save: async (doc) => { permSaved.push({ ...doc }) },
    },
    listProviderIds: async () => ['lobsterai', 'trae'],
    claim: async () => ({ ok: true, value: {
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 8, inactive: 0, failed: 2, coversToday: 8 },
      results: [
        { accountId: 'l1', nickname: 'lobster', outcome: { kind: 'failed', code: -1, message: '活动槽位查询失败' } },
        { accountId: 't1', nickname: 'trae', outcome: { kind: 'failed', code: 1001, message: "We're sorry, but we are not able to authenticate you." } },
      ],
    } }),
    warn: () => {},
    delayMs: 0,
    intervalSchedule: (fn) => { return { cancel() {} } },
    schedule: () => ({ cancel() {} }),
  }
  const perm = sandbox.__make(permDeps)
  perm.start()
  await new Promise(r => setTimeout(r, 5))
  check('permanent-only failures still record their reasons', perm.state().details.length === 4)
  check('permanent-only failures CLOSE the day', perm.state().ranToday === true)
  check('the failure record still shows on the card', perm.state().details[1].reason.includes('authenticate'))
  // A second tick must now be a no-op — that is the whole point of the fix.
  const before = perm.state().history.length
  perm.start()
  await new Promise(r => setTimeout(r, 5))
  check('the day stays closed after permanent failures', perm.state().history.length === before)
}

// ---------------------------------------------------------------- 7. stop() cancels the recurring timer
checkin.stop()
check('stop() cancels the recurring timer', stoppedInterval === true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
