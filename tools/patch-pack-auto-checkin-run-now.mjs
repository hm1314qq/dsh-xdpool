/**
 * Patch channel-pack: an explicit "claim now" action for the details dialog.
 *
 * Before this, the ONLY way to trigger a batch claim was toggling the global
 * switch off/on, and `runIfDue()` refused to run when `lastDate === today()`.
 * So after the 09:00 pass there was no way to re-run it — exactly when a user
 * wants to retry an account that failed that morning.
 *
 * This patch adds `runNow(force)`:
 *   - `force` skips the "already covered today" gate, but still respects
 *     `doc.enabled` (a switched-off automation must stay off) and `inflight`
 *     (a slow pass cannot overlap the next one).
 *   - Repeating a claim is SAFE: every provider's claim is idempotent and an
 *     already-collected account comes back as `already-claimed`, counted but
 *     never collected twice.
 *   - The run goes through the same `performRun()`, so it is recorded in the
 *     rolling history and its per-account breakdown lands in `details`.
 *
 * `usage.autoCheckin` gains a `run: true` request branch. It awaits the pass
 * (the host's RPC timeout is 180 s, a pass takes tens of seconds) and returns
 * the fresh `state()`, so the dialog can refresh without a second round trip.
 *
 * Idempotent, marked `[xdpool-local] auto-checkin-run-now`.
 * Run AFTER patch-pack-auto-checkin-history.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] auto-checkin-run-now'

const source = readFileSync(PATH, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const lines = source.split(/\r?\n/)

function insertBefore(anchor, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index, 0, ...block)
}
function insertAfter(anchor, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index + 1, 0, ...block)
}
function replaceBlock(anchor, count, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index, count, ...block)
}

// ---------------------------------------------------------------- 1. shared runner
replaceBlock(
  '  function runIfDue() {',
  14,
  [
    '  // ' + MARKER + ': one place that actually starts a pass. `force` skips',
    '  // ONLY the "already covered today" gate; the enabled switch and the',
    '  // in-flight guard still apply, so a manual click can never overlap a',
    '  // scheduled pass or resurrect a switched-off automation.',
    '  function startRun(force) {',
    '    if (inflight !== null) return inflight;',
    '    if (!doc.enabled) return Promise.resolve();',
    '    if (!force && doc.lastDate !== "" && doc.lastDate === today()) return Promise.resolve();',
    '    running2 = true;',
    '    const task = performRun().catch((error) => {',
    '      deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\u5F02\\u5E38: ${String(error)}`);',
    '    }).finally(() => {',
    '      running2 = false;',
    '      inflight = null;',
    '    });',
    '    inflight = task;',
    '    return task;',
    '  }',
    '  function runIfDue() {',
    '    return startRun(false);',
    '  }',
  ],
)

// ---------------------------------------------------------------- 2. expose runNow
insertBefore(
  '    async setEnabled(enabled) {',
  [
    '    // ' + MARKER + ': the details dialog\'s "claim now" button.',
    '    async runNow() {',
    '      await startRun(true);',
    '      return state();',
    '    },',
  ],
)

// ---------------------------------------------------------------- 3. RPC branch
insertBefore(
  '        if (req.enabled === void 0) {',
  [
    '        // ' + MARKER + ': explicit manual batch claim. Awaited so the',
    '        // dialog receives the NEW state (details + history) in one call.',
    '        if (req.run === true) {',
    '          const value3 = { autoCheckin: await autoCheckin.runNow() };',
    '          return { ok: true, value: value3 };',
    '        }',
  ],
)

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('function startRun(force)')) throw new Error('startRun missing')
if (!text.includes('async runNow()')) throw new Error('runNow missing')
if (!text.includes('if (req.run === true)')) throw new Error('RPC branch missing')
if (!text.includes('return startRun(false);')) throw new Error('runIfDue not rewired')
writeFileSync(PATH, text)
console.log('patched: usage.autoCheckin { run: true } now forces a batch claim')
