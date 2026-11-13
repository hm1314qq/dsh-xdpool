/**
 * Patch channel-pack: tell a RETRYABLE failure from a PERMANENT one, and stop
 * the history from filling up with identical rows.
 *
 * WHY
 *
 * The earlier "a failed pass does not close the day" fix is right for a blip
 * and wrong for a broken account. Measured in the field the same morning:
 * `lobsterai` answered "活动槽位查询失败" and `trae` answered an auth refusal
 * (code 1001) — neither will fix itself by retrying in an hour. Because
 * `shouldMarkToday()` demanded `failed === 0`, the recurring timer re-ran the
 * whole roster EVERY HOUR:
 *
 *   - ~24 full passes × 13 accounts of pointless upstream traffic per day;
 *   - the 120-entry history cap was consumed in ~5 days, making the 30-day
 *     window meaningless;
 *   - three manual clicks produced three byte-identical history entries.
 *
 * THE FIX
 *
 *  1. Classify each failure. Only RETRYABLE ones keep the day open:
 *     network/timeout/5xx/429 and unknown errors. Auth refusals, risk control,
 *     "not supported", unconfigured credentials and ended promotions are
 *     PERMANENT for the day — recorded with their reason, but not retried.
 *  2. `shouldMarkToday()` closes the day when there are no retryable failures,
 *     even if permanent ones remain. The card still shows them.
 *  3. History de-duplicates consecutive IDENTICAL runs: the timestamp is
 *     refreshed and `runs` incremented instead of appending a clone. A run that
 *     differs in any way is still its own entry, so the process stays visible.
 *
 * Idempotent, marked `[xdpool-local] auto-checkin-retry-policy`.
 * Run AFTER patch-pack-auto-checkin-run-now.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] auto-checkin-retry-policy'

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

const ESC = (s) => s.replace(/[^\x20-\x7e]/gu, ch => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))

// ---------------------------------------------------------------- 1. the classifier
insertBefore('function shouldMarkToday(totals) {', [
  '// ' + MARKER + ': which failures are worth retrying.',
  '//',
  '// A blip (timeout, 5xx, 429) is worth another pass later today. A refused',
  '// login, a risk-control block, a provider with no check-in API or a finished',
  '// promotion is not: retrying only burns upstream quota and fills the history.',
  '// Anything unrecognised is treated as RETRYABLE on purpose — an unknown error',
  '// is more likely transient than permanent, and wrongly giving up is worse than',
  '// one extra cheap pass.',
  'var PERMANENT_FAILURE_PATTERNS = [',
  '  /authenticate/iu, /unauthoriz/iu, /forbidden/iu, /invalid_grant/iu,',
  '  /\\b40[13]\\b/u, /unusual activity/iu, /blocked/iu,',
  '  /not supported/iu, /unsupported/iu,',
  '  /expired/iu,',
  '  /' + ESC('登录已失效') + '/u, /' + ESC('重新登录') + '/u, /' + ESC('凭据') + '/u,',
  '  /' + ESC('风控') + '/u, /' + ESC('不支持') + '/u,',
  '  /' + ESC('活动已结束') + '/u, /' + ESC('已过期') + '/u, /' + ESC('活动槽位查询失败') + '/u,',
  '];',
  'function isRetryableFailure(row) {',
  '  if (row === null || typeof row !== "object") return true;',
  '  if (row.status !== "failed") return false;',
  '  // A risk-control / auth business code is permanent even when the message is',
  '  // unhelpful: 1001 and 3012 were both measured as refusals.',
  '  if (row.code === 1001 || row.code === 3012) return false;',
  '  if (row.code === 401 || row.code === 403) return false;',
  '  const text = typeof row.reason === "string" ? row.reason : "";',
  '  if (text === "") return true;',
  '  return !PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));',
  '}',
  '/** How many rows would still be worth another pass today. */',
  'function retryableFailureCount(rows) {',
  '  let count = 0;',
  '  for (const row of rows) if (isRetryableFailure(row)) count += 1;',
  '  return count;',
  '}',
  '',
])

// ---------------------------------------------------------------- 2. shouldMarkToday takes the rows
replaceBlock(
  'function shouldMarkToday(totals) {',
  3,
  [
    '// ' + MARKER + ': the day closes when nothing RETRYABLE failed. Permanent',
    '// failures stay visible on the card but must not keep the retry armed —',
    '// that is what made one broken account re-run all thirteen every hour.',
    'function shouldMarkToday(totals, retryableFailures) {',
    '  if (totals.coversToday <= 0) return false;',
    '  if (totals.errors > 0) return false;',
    '  return (retryableFailures ?? totals.failed) === 0;',
    '}',
  ],
)

// performRun must pass the retryable count. Both the call site and the
// arguments change together, so a missing update fails the syntax check.
replaceBlock(
  '    if (!shouldMarkToday(totals)) {',
  1,
  [
    '    // ' + MARKER + ': only retryable failures keep the day open.',
    '    const retryable = retryableFailureCount(details);',
    '    if (!shouldMarkToday(totals, retryable)) {',
  ],
)

// A permanent-only failure CLOSES the day, so the warning belongs on the
// success path — that is the only place it can explain why an account still
// shows as failed while no further pass is scheduled.
insertBefore(
  '    // [xdpool-local] auto-checkin-history: record this run before overwriting the snapshot.',
  [
    '    // ' + MARKER + ': permanent failures did not keep the day open.',
    '    if (totals.failed > 0 && retryable === 0) {',
    '      deps.warn?.(`[channel-pack] ' + ESC('自动签到：') + '${String(totals.failed)} ' + ESC('个永久性失败（凭据/风控/无接口），今日不再重试') + '`);',
    '    }',
  ],
)

// ---------------------------------------------------------------- 3. history de-duplication
// Identical consecutive runs collapse into one entry with a `runs` counter and
// a refreshed timestamp, instead of appending a byte-identical clone.
replaceBlock(
  'function appendHistory(existing, entry, nowMs) {',
  11,
  [
    '/** ' + MARKER + ': two runs are "the same" when nothing a reader cares about differs. */',
    'function sameHistoryRun(a, b) {',
    '  if (a === null || typeof a !== "object") return false;',
    '  // Compare the outcome shape only: `at` and `runs` are bookkeeping.',
    '  return a.result === b.result',
    '    && JSON.stringify(a.totals ?? {}) === JSON.stringify(b.totals ?? {})',
    '    && JSON.stringify(a.details ?? []) === JSON.stringify(b.details ?? []);',
    '}',
    '/** Append one run, collapsing a repeat of the previous one. */',
    'function appendHistory(existing, entry, nowMs) {',
    '  const cutoff = nowMs - HISTORY_WINDOW_MS;',
    '  const kept = (Array.isArray(existing) ? existing : []).filter(',
    '    (row) => row !== null && typeof row === "object"',
    '      && typeof row.at === "number" && Number.isFinite(row.at)',
    '      && row.at >= cutoff && row.at !== entry.at,',
    '  );',
    '  const last = kept[kept.length - 1];',
    '  if (last !== void 0 && sameHistoryRun(last, entry)) {',
    '    // Same outcome as the previous pass: count it, move the stamp forward,',
    '    // and keep the original position so the ordering still reads oldest-first.',
    '    kept[kept.length - 1] = {',
    '      ...last,',
    '      at: entry.at,',
    '      date: entry.date,',
    '      runs: (typeof last.runs === "number" ? last.runs : 1) + 1,',
    '    };',
    '    return kept.slice(-MAX_HISTORY_ENTRIES);',
    '  }',
    '  kept.push({ ...entry, runs: 1 });',
    '  return kept.slice(-MAX_HISTORY_ENTRIES);',
    '}',
  ],
)

// `runs` must survive the sanitizer, or the counter resets on every reload.
insertAfter(
  '      totals: sanitizeHistoryTotals(record.totals),',
  ['      ...typeof record.runs === "number" && Number.isFinite(record.runs) && record.runs > 0 ? { runs: Math.floor(record.runs) } : {},'],
)

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('function isRetryableFailure(row)')) throw new Error('classifier missing')
if (!text.includes('function retryableFailureCount(rows)')) throw new Error('counter missing')
if (!text.includes('function shouldMarkToday(totals, retryableFailures)')) throw new Error('shouldMarkToday not rewired')
if (!text.includes('const retryable = retryableFailureCount(details);')) throw new Error('call site not rewired')
if (!text.includes('function sameHistoryRun(a, b)')) throw new Error('dedupe predicate missing')
if (!text.includes('runs: (typeof last.runs === "number" ? last.runs : 1) + 1')) throw new Error('dedupe not wired')
writeFileSync(PATH, text)
console.log('patched: failures are classified, only retryable ones keep the day open, history de-duplicates')
