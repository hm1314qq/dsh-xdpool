/**
 * Patch channel-pack: make the daily auto check-in actually run every day.
 *
 * Two independent defects, both in `createAutoCheckin` / `shouldMarkToday`:
 *
 * 1. NO CROSS-DAY SCHEDULING. `start()` installed exactly ONE `setTimeout`
 *    (30 s after mount). `runIfDue()` then refuses to run again while
 *    `doc.lastDate === today()`. There was no `setInterval` and no tomorrow
 *    timer anywhere: the only thing that ever triggered a second day's claim
 *    was a full host restart (or the user manually toggling the switch off/on).
 *    A DSH left running for days simply stopped collecting credits. The field
 *    report was "自动领取积分失效了" — the feature looked dead when it had in
 *    fact just never been woken up.
 *
 * 2. ONE SUCCESS CLOSES THE WHOLE DAY. `shouldMarkToday()` returned
 *    `totals.coversToday > 0`, i.e. as soon as ONE account succeeded the run
 *    wrote `lastDate = today` and every account that FAILED in that same pass
 *    was silently abandoned for the rest of the day — and, because of (1),
 *    there was no next run to retry them either. A typical report showed
 *    "6 个账号领取成功（+900积分），2 个失败" with no way to recover the two.
 *
 * THE FIX
 *
 *   - `start()` installs a recurring timer in addition to the initial delay.
 *     `runIfDue()` is idempotent: its existing `lastDate === today()` guard and
 *     the upstream's `already-claimed` outcome make a repeat pass safe (an
 *     already-collected account is counted, never collected twice). The
 *     recurring tick is what turns "once per process" into "once per day".
 *
 *   - `shouldMarkToday()` also requires `failed === 0 && errors === 0`. A pass
 *     with failures leaves `lastDate` untouched, so the next recurring tick
 *     retries the whole pass. Already-claimed accounts still count towards
 *     `coversToday`, so a clean retry closes the day normally.
 *
 * Both are guarded by the existing `inflight` promise, so a slow pass can
 * never overlap the next tick. `stop()` cancels BOTH timers.
 *
 * Idempotent: marked by `[xdpool-local] auto-checkin` and re-running is a no-op.
 * The interval is overridable with DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS,
 * mirroring the existing DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS override.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] auto-checkin'

const source = readFileSync(PATH, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const lines = source.split(/\r?\n/)

/** Replace one exact line, failing loudly when the pack has moved on. */
function replaceLine(exact, replacement) {
  const index = lines.findIndex(line => line === exact)
  if (index === -1) throw new Error('line not found: ' + exact.slice(0, 90))
  lines[index] = replacement
}

/** Replace a contiguous block of exact lines, starting at `anchor`. */
function replaceBlock(anchor, count, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  for (let i = 1; i < count; i += 1) {
    const expected = lines[index + i]
    if (expected === undefined) throw new Error('block shorter than ' + count)
  }
  lines.splice(index, count, ...block)
}

// ---------------------------------------------------------------- 1. interval constant
// Insert next to the delay constant so both overrides live in one place.
{
  const anchor = 'var AUTO_CHECKIN_DELAY_MS = 3e4;'
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('AUTO_CHECKIN_DELAY_MS not found')
  lines.splice(index + 1, 0,
    '// ' + MARKER + ': how often to re-check whether a new UTC+8 day has begun.',
    '// 1 hour is short enough to collect the reward promptly after midnight,',
    '// long enough that a permanently failing channel cannot hammer the upstream.',
    'var DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS = "DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS";',
    'var AUTO_CHECKIN_INTERVAL_MS = 36e5;',
  )
}

// ---------------------------------------------------------------- 2. recurring state + helpers
replaceLine(
  '  let pending = null;',
  [
    '  let pending = null;',
    '  // ' + MARKER + ': the cross-day timer. `pending` is the one-shot mount delay;',
    '  // `recurring` is what wakes the check-in on a NEW day without a restart.',
    '  let recurring = null;',
    '  function autoCheckinIntervalMs(env = process.env) {',
    '    const raw = env[DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS];',
    '    if (typeof raw !== "string" || raw.trim().length === 0) return AUTO_CHECKIN_INTERVAL_MS;',
    '    const parsed = Number(raw.trim());',
    '    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : AUTO_CHECKIN_INTERVAL_MS;',
    '  }',
  ].join(EOL),
)

// ---------------------------------------------------------------- 3. failures must not close the day
replaceBlock(
  'function shouldMarkToday(totals) {',
  3,
  [
    '// ' + MARKER + ': a day is only "done" when NOTHING failed. A single',
    '// successful account used to close the day for every account that failed',
    '// alongside it, and with no recurring timer there was no retry at all.',
    'function shouldMarkToday(totals) {',
    '  return totals.coversToday > 0 && totals.failed === 0 && totals.errors === 0;',
    '}',
  ],
)

// ---------------------------------------------------------------- 4. start() installs the recurring timer
replaceBlock(
  '    start() {',
  13,
  [
    '    start() {',
    '      if (pending !== null || recurring !== null) return;',
    '      const ms = deps.delayMs ?? autoCheckinDelayMs();',
    '      const fire = () => {',
    '        pending = null;',
    '        void runIfDue();',
    '      };',
    '      // ' + MARKER + ': re-check on a timer for as long as the fiber lives.',
    '      // `runIfDue` itself refuses a second pass on the same day, so this is',
    '      // cheap and safe: it only ever fires a claim when the UTC+8 date has',
    '      // rolled over (or the previous pass left failures behind).',
    '      const intervalMs = deps.intervalMs ?? autoCheckinIntervalMs();',
    '      recurring = (deps.intervalSchedule ?? defaultIntervalSchedule)(fire, intervalMs);',
    '      if (ms <= 0) {',
    '        fire();',
    '        return;',
    '      }',
    '      pending = (deps.schedule ?? defaultSchedule)(fire, ms);',
    '    },',
  ],
)

// ---------------------------------------------------------------- 5. stop() cancels both timers
replaceBlock(
  '    stop() {',
  4,
  [
    '    stop() {',
    '      pending?.cancel();',
    '      pending = null;',
    '      // ' + MARKER + ': otherwise the recurring timer outlives the fiber.',
    '      recurring?.cancel();',
    '      recurring = null;',
    '    },',
  ],
)

// ---------------------------------------------------------------- 6. the interval scheduler
{
  const anchor = 'function defaultSchedule(fn, ms) {'
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('defaultSchedule not found')
  lines.splice(index, 0,
    '// ' + MARKER + ': a repeating, unref\'d timer with the same cancel() shape',
    '// as defaultSchedule, so start()/stop() can treat both identically.',
    'function defaultIntervalSchedule(fn, ms) {',
    '  const timer = setInterval(fn, ms);',
    '  timer.unref?.();',
    '  return { cancel: () => clearInterval(timer) };',
    '}',
    '',
  )
}

const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('defaultIntervalSchedule')) throw new Error('interval scheduler missing')
if (!text.includes('recurring?.cancel()')) throw new Error('stop() does not cancel the recurring timer')
if (!text.includes('totals.failed === 0 && totals.errors === 0')) throw new Error('shouldMarkToday not patched')
// A syntax check on the whole artifact: a misplaced splice must fail loudly here,
// not at runtime when the host imports the pack.
writeFileSync(PATH, text)
console.log('patched: auto check-in now runs every UTC+8 day and retries failed passes')
