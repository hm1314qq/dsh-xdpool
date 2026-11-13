/**
 * Patch channel-pack: keep a rolling 30-day HISTORY of auto check-in runs.
 *
 * `auto-checkin.json` used to be a single SNAPSHOT: every run overwrote
 * `lastDate`/`lastResult`/`channels`/`details`. So there was no way to answer
 * "what did it collect yesterday?", "has this account been failing for a
 * week?", or "how much did I get this month?". A failed pass (which does not
 * close the day) was even more short-lived — its breakdown was overwritten by
 * the next successful retry.
 *
 * The details dialog asked for a date switcher, so the pack now appends one
 * entry PER RUN (every retry included, de-duplicated by `at`), keeps 30 days
 * (and at most 120 entries, so a bad day of hourly retries cannot grow the
 * file), and returns the whole history from `state()` → `usage.autoCheckin`.
 *
 * Idempotent, marked `[xdpool-local] auto-checkin-history`.
 * Run AFTER patch-pack-auto-checkin-details.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] auto-checkin-history'

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
function replaceLine(exact, replacement) {
  const index = lines.findIndex(line => line === exact)
  if (index === -1) throw new Error('line not found: ' + exact.slice(0, 90))
  lines[index] = replacement
}

// ---------------------------------------------------------------- 1. constants + sanitizer
insertBefore('function sanitizeAutoCheckin(raw) {', [
  '// ' + MARKER + ': rolling history. Two independent bounds: a TIME window',
  '// (30 days) and an ENTRY count (120). The count matters because a failed',
  '// pass retries every hour — a bad day must not push out the whole month.',
  'var MAX_HISTORY_DAYS = 30;',
  'var MAX_HISTORY_ENTRIES = 120;',
  'var HISTORY_WINDOW_MS = MAX_HISTORY_DAYS * 24 * 3600 * 1000;',
  'function sanitizeHistoryTotals(raw) {',
  '  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};',
  '  const record = raw;',
  '  const out = {};',
  '  for (const key of ["claimed", "failed", "alreadyClaimed", "inactive", "credit"]) {',
  '    if (typeof record[key] === "number" && Number.isFinite(record[key])) out[key] = record[key];',
  '  }',
  '  return out;',
  '}',
  'function sanitizeHistory(raw, nowMs = Date.now()) {',
  '  if (!Array.isArray(raw)) return [];',
  '  const cutoff = nowMs - HISTORY_WINDOW_MS;',
  '  const seen = new Set();',
  '  const out = [];',
  '  for (const item of raw) {',
  '    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;',
  '    const record = item;',
  '    if (typeof record.at !== "number" || !Number.isFinite(record.at) || record.at <= 0) continue;',
  '    if (record.at < cutoff) continue;',
  '    if (seen.has(record.at)) continue;',
  '    seen.add(record.at);',
  '    out.push({',
  '      at: record.at,',
  '      date: typeof record.date === "string" && DATE_RE.test(record.date) ? record.date : "",',
  '      result: typeof record.result === "string" ? record.result.slice(0, 400) : "",',
  '      totals: sanitizeHistoryTotals(record.totals),',
  '      // Reuse the same whitelist as the live `details` field, so a dirty',
  '      // history entry can never smuggle a huge or malformed row into the UI.',
  '      details: sanitizeDetails(record.details),',
  '    });',
  '    if (out.length >= MAX_HISTORY_ENTRIES) break;',
  '  }',
  '  return out.sort((a, b) => a.at - b.at);',
  '}',
  '/** Append one run, de-duplicated by `at`, then apply both bounds. */',
  'function appendHistory(existing, entry, nowMs) {',
  '  const cutoff = nowMs - HISTORY_WINDOW_MS;',
  '  const kept = (Array.isArray(existing) ? existing : []).filter(',
  '    (row) => row !== null && typeof row === "object"',
  '      && typeof row.at === "number" && Number.isFinite(row.at)',
  '      && row.at >= cutoff && row.at !== entry.at,',
  '  );',
  '  kept.push(entry);',
  '  kept.sort((a, b) => a.at - b.at);',
  '  return kept.slice(-MAX_HISTORY_ENTRIES);',
  '}',
  '',
])

// ---------------------------------------------------------------- 2. document shape
replaceLine(
  '  details: []',
  '  details: [],',
)
insertAfter(
  '  details: [],',
  ['  history: []'],
)
insertAfter(
  '    details: sanitizeDetails(record.details),',
  ['    history: sanitizeHistory(record.history, Date.now()),'],
)
insertAfter(
  '      details: doc.details ?? [],',
  ['      history: doc.history ?? [],'],
)

// ---------------------------------------------------------------- 3. append on BOTH end paths
// A shared helper inside createAutoCheckin builds the history entry from the
// run we just completed, so the failed and successful paths cannot drift.
insertBefore('  async function performRun() {', [
  '  // ' + MARKER + ': one entry per run, including failed/retry passes.',
  '  function historyEntry(totals, result, detailRows, at) {',
  '    return {',
  '      at,',
  '      date: utc8DateString(at),',
  '      result,',
  '      totals: {',
  '        claimed: totals.claimed,',
  '        failed: totals.failed,',
  '        alreadyClaimed: totals.alreadyClaimed,',
  '        inactive: totals.inactive,',
  '        credit: totals.totalCredit,',
  '      },',
  '      details: detailRows.slice(0, MAX_DETAIL_ENTRIES),',
  '    };',
  '  }',
  '',
])

// Failed pass: persist details AND append its own history entry.
replaceLine(
  '      doc = { ...doc, details: details.slice(0, MAX_DETAIL_ENTRIES) };',
  [
    '      const failedAt = now();',
    '      doc = {',
    '        ...doc,',
    '        details: details.slice(0, MAX_DETAIL_ENTRIES),',
    '        history: appendHistory(doc.history, historyEntry(totals, describeRun(totals), details, failedAt), failedAt),',
    '      };',
  ].join(EOL),
)

// Successful pass: append alongside the normal snapshot write. `now()` is
// called once so `lastAt` and the history entry share the exact instant.
insertBefore('    doc = {', [
  '    // ' + MARKER + ': record this run before overwriting the snapshot.',
  '    const runAt = now();',
])
replaceLine(
  '      lastAt: now(),',
  '      lastAt: runAt,',
)
insertAfter(
  '      details: details.slice(0, MAX_DETAIL_ENTRIES),',
  ['      history: appendHistory(doc.history, historyEntry(totals, describeRun(totals), details, runAt), runAt),'],
)

// ---------------------------------------------------------------- 4. expose via state()
insertAfter(
  '      details: (doc.details ?? []).map((entry) => ({ ...entry })),',
  ['      // ' + MARKER + ': newest-last, for the dialog\'s date switcher.',
    '      history: (doc.history ?? []).map((entry) => ({',
    '        ...entry,',
    '        details: (entry.details ?? []).map((row) => ({ ...row })),',
    '      })),'],
)

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('function sanitizeHistory(raw, nowMs = Date.now())')) throw new Error('sanitizer missing')
if (!text.includes('function appendHistory(existing, entry, nowMs)')) throw new Error('appendHistory missing')
if (!text.includes('history: sanitizeHistory(record.history, Date.now())')) throw new Error('load not wired')
if (!text.includes('history: doc.history ?? []')) throw new Error('save not wired')
if (!text.includes('function historyEntry(totals, result, detailRows, at)')) throw new Error('entry builder missing')
const appendCount = (text.match(/appendHistory\(doc\.history/gu) ?? []).length
if (appendCount !== 2) throw new Error(`expected 2 append sites, found ${String(appendCount)}`)
if (!text.includes('history: (doc.history ?? []).map')) throw new Error('state() not wired')
writeFileSync(PATH, text)
console.log('patched: auto check-in now keeps a rolling 30-day run history')
