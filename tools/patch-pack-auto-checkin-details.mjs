/**
 * Patch channel-pack: persist and expose a PER-ACCOUNT claim detail breakdown.
 *
 * The auto-check-in card only showed one compressed line per provider
 * ("1 个 +100积分，1 个失败"). There was no way to answer "which account
 * failed, and why?" — the `results` array that `credits.claimAll` already
 * returns (accountId / nickname / outcome.kind / outcome.message / credit)
 * was thrown away by `performRun()`, which kept only the aggregate `summary`.
 *
 * This patch:
 *   1. Adds a `details` array to the persisted `auto-checkin.json` document
 *      (sanitized on load, capped, so a dirty or huge file cannot hurt us).
 *   2. Fills it in `performRun()` from each provider's claim result:
 *        - excluded (manual)      -> one `skipped` row
 *        - thrown / ok:false      -> one `failed` row with the reason
 *        - unsupported provider   -> one `unsupported` row
 *        - no claimable account   -> one `none` row
 *        - `value.results[]`      -> one row per account, with status, amount,
 *          unit and the upstream's own failure message
 *   3. Returns `details` from `state()`, which `usage.autoCheckin` already
 *      forwards verbatim — no RPC change needed.
 *
 * The Chinese strings are written as \uXXXX escapes because pack.js is a
 * build artifact that stores its Chinese that way; a literal 领取失败 would
 * never match an anchor.
 *
 * Idempotent, marked `[xdpool-local] auto-checkin-details`.
 * Run AFTER patch-pack-auto-checkin.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] auto-checkin-details'

const source = readFileSync(PATH, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const lines = source.split(/\r?\n/)

/** Insert `block` immediately BEFORE the first line equal to `anchor`. */
function insertBefore(anchor, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index, 0, ...block)
}

/** Insert `block` immediately AFTER the first line equal to `anchor`. */
function insertAfter(anchor, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index + 1, 0, ...block)
}

/** Insert `block` after EVERY line equal to `anchor`; returns the hit count. */
function insertAfterAll(anchor, block) {
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === anchor) hits.push(i)
  // Walk backwards so earlier indices are not shifted by later insertions.
  for (let n = hits.length - 1; n >= 0; n -= 1) lines.splice(hits[n] + 1, 0, ...block)
  return hits.length
}

/** Replace one exact line, failing loudly when the pack has moved on. */
function replaceLine(exact, replacement) {
  const index = lines.findIndex(line => line === exact)
  if (index === -1) throw new Error('line not found: ' + exact.slice(0, 90))
  lines[index] = replacement
}

const ESC = (s) => s.replace(/[^\x20-\x7e]/gu, ch => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))

// ---------------------------------------------------------------- 1. cap + sanitizer
insertBefore('function sanitizeAutoCheckin(raw) {', [
  '// ' + MARKER + ': per-account rows from the last run, kept bounded so a',
  '// provider with many accounts/plans cannot grow the settings file without limit.',
  'var MAX_DETAIL_ENTRIES = 200;',
  'function sanitizeDetails(raw) {',
  '  if (!Array.isArray(raw)) return [];',
  '  const out = [];',
  '  for (const item of raw) {',
  '    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;',
  '    const record = item;',
  '    if (typeof record.provider !== "string" || record.provider.length === 0) continue;',
  '    if (typeof record.status !== "string") continue;',
  '    const row = {',
  '      provider: record.provider.slice(0, 40),',
  '      status: record.status.slice(0, 40),',
  '    };',
  '    if (typeof record.accountId === "string") row.accountId = record.accountId.slice(0, 80);',
  '    if (typeof record.nickname === "string") row.nickname = record.nickname.slice(0, 80);',
  '    if (typeof record.reason === "string") row.reason = record.reason.slice(0, 300);',
  '    if (typeof record.unit === "string") row.unit = record.unit.slice(0, 20);',
  '    if (typeof record.amount === "number" && Number.isFinite(record.amount)) row.amount = record.amount;',
  '    if (typeof record.code === "number" && Number.isFinite(record.code)) row.code = record.code;',
  '    out.push(row);',
  '    if (out.length >= MAX_DETAIL_ENTRIES) break;',
  '  }',
  '  return out;',
  '}',
  '',
])

// ---------------------------------------------------------------- 2. document shape
insertBefore('var DEFAULT_AUTO_CHECKIN = {', [
  '// ' + MARKER + ': the last run, account by account, for the details dialog.',
])
replaceLine(
  '  dismissedRunAt: 0',
  '  dismissedRunAt: 0,',
)
insertAfter(
  '  dismissedRunAt: 0,',
  ['  details: []'],
)
// sanitizeAutoCheckin: add the field.
insertAfter(
  '    channels: sanitizeChannels(record.channels),',
  ['    details: sanitizeDetails(record.details),'],
)
// FileAutoCheckinStore.save: persist it.
insertAfter(
  '      channels: doc.channels,',
  ['      details: doc.details ?? [],'],
)

// ---------------------------------------------------------------- 3. flatten helper
insertBefore('function createAutoCheckin(deps) {', [
  '// ' + MARKER + ': flatten one provider\'s claim result into rows the dialog',
  '// can group. `results` is what every credits.claimAll branch returns; the',
  '// upstream\'s own message is kept verbatim as `reason` — it is the only',
  '// place that says WHY an account failed.',
  'function autoCheckinDetailRows(provider, result) {',
  '  if (!result.ok) {',
  '    const message = typeof result.error?.message === "string" ? result.error.message : "";',
  '    return [{ provider, status: "failed", reason: message !== "" ? message : "unknown-error" }];',
  '  }',
  '  const results = result.value?.results;',
  '  if (!Array.isArray(results) || results.length === 0) {',
  '    return [{ provider, status: "none", reason: "no-claimable-account" }];',
  '  }',
  '  const rows = [];',
  '  for (const entry of results) {',
  '    const outcome = entry?.outcome;',
  '    const kind = typeof outcome?.kind === "string" ? outcome.kind : "failed";',
  '    const row = {',
  '      provider,',
  '      status: kind,',
  '      ...typeof entry?.accountId === "string" ? { accountId: entry.accountId } : {},',
  '      ...typeof entry?.nickname === "string" ? { nickname: entry.nickname } : {},',
  '      ...typeof outcome?.credit === "number" && Number.isFinite(outcome.credit) ? { amount: outcome.credit } : {},',
  '      ...typeof outcome?.unit === "string" ? { unit: outcome.unit } : {},',
  '      ...typeof outcome?.code === "number" && Number.isFinite(outcome.code) ? { code: outcome.code } : {},',
  '      ...typeof outcome?.message === "string" && outcome.message !== "" ? { reason: outcome.message } : {},',
  '    };',
  '    rows.push(row);',
  '  }',
  '  return rows;',
  '}',
  '',
])

// ---------------------------------------------------------------- 4. collect in performRun
replaceLine(
  '    const channels = [];',
  [
    '    const channels = [];',
    '    // ' + MARKER + ': every row of the last run, across all providers.',
    '    const details = [];',
  ].join(EOL),
)

// Excluded (zcode): a deliberate skip, not a failure.
insertAfter(
  '        channels.push({ provider, text: "' + ESC('需手动签到') + '" });',
  ['        details.push({ provider, status: "skipped", reason: "manual-checkin-required" });'],
)
// Both "出错" branches (the RPC threw, and ok:false) use the SAME line, so
// insert after BOTH. `result` is `undefined` in the throw branch (declared with
// `let result;`), hence the fallback; the ok:false branch has the real envelope.
const errorHits = insertAfterAll(
  '        channels.push({ provider, text: "' + ESC('出错') + '" });',
  ['        details.push(...autoCheckinDetailRows(provider, result ?? { ok: false, error: { message: "claim-call-failed" } }));'],
)
if (errorHits !== 2) throw new Error(`expected 2 error branches, found ${String(errorHits)}`)
// "无签到接口": the provider has no check-in API at all. A deliberate skip,
// not a failure — the dialog groups it separately so it does not read as a
// broken account. `message2` is the upstream's own explanation.
insertAfter(
  '          channels.push({ provider, text: "' + ESC('无签到接口') + '" });',
  ['          details.push({ provider, status: "unsupported", reason: message2 !== "" ? message2 : "no-checkin-api" });'],
)
// "无可领": ok:true but no summary at all.
insertAfter(
  '        channels.push({ provider, text: "' + ESC('无可领') + '" });',
  ['        details.push(...autoCheckinDetailRows(provider, result));'],
)
// Successful branch: expand the per-account results.
insertAfter(
  '      channels.push({ provider, text: describeChannel(summary) });',
  ['      details.push(...autoCheckinDetailRows(provider, result));'],
)

// Persist the collected rows with the run document.
insertAfter(
  '      channels,',
  ['      details: details.slice(0, MAX_DETAIL_ENTRIES),'],
)

// ---------------------------------------------------------------- 5. a failed pass still has details
// `performRun` returns early when shouldMarkToday() is false (a failed pass must
// not close the day). That early return happens BEFORE the `doc = {...}` write,
// so without this the breakdown would be lost on exactly the runs the user most
// wants to inspect. Persist details without touching lastDate/lastAt.
// Find the `warn` line and splice the doc update in before `return;`.
{
  const warnAnchor = '        `[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\u672A\\u8BB0\\u5165\\u4ECA\\u65E5\\uFF08\\u4E0B\\u6B21\\u542F\\u52A8\\u4F1A\\u91CD\\u8BD5\\uFF09\\uFF1A${describeRun(totals)}`'
  const index = lines.findIndex(line => line === warnAnchor)
  if (index === -1) throw new Error('shouldMarkToday warn line not found')
  // `return;` is two lines below the closing `);`
  const ret = lines.findIndex((line, i) => i > index && line === '      return;')
  if (ret === -1) throw new Error('early return not found')
  lines.splice(ret, 0,
    '      // ' + MARKER + ': a FAILED pass is exactly when the',
    '      // per-account reasons matter most. Do not update lastDate/lastAt (that is',
    '      // what keeps the retry armed), but DO persist the breakdown so the',
    '      // details dialog can answer "which account failed, and why".',
    '      doc = { ...doc, details: details.slice(0, MAX_DETAIL_ENTRIES) };',
    '      try {',
    '        await deps.store.save(doc);',
    '      } catch (error) {',
    '        deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\u660E\\u7EC6\\u5199\\u5165\\u5931\\u8D25: ${String(error)}`);',
    '      }',
  )
}

// ---------------------------------------------------------------- 6. expose via state()
insertAfter(
  '      channels: doc.channels.map((entry) => ({ ...entry })),',
  ['      // ' + MARKER + ': the per-account breakdown shown by the details dialog.',
    '      details: (doc.details ?? []).map((entry) => ({ ...entry })),'],
)

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('autoCheckinDetailRows')) throw new Error('detail helper missing')
if (!text.includes('details: sanitizeDetails(record.details)')) throw new Error('sanitizer not wired')
if (!text.includes('details: doc.details ?? []')) throw new Error('save() not wired')
if (!text.includes('details: details.slice(0, MAX_DETAIL_ENTRIES)')) throw new Error('performRun not wired')
if (!text.includes('details: (doc.details ?? []).map')) throw new Error('state() not wired')
if (!text.includes('doc = { ...doc, details: details.slice(0, MAX_DETAIL_ENTRIES) }')) throw new Error('failed-pass details not persisted')
if (!text.includes('status: "unsupported"')) throw new Error('unsupported branch not labelled')
writeFileSync(PATH, text)
console.log('patched: auto check-in now records and exposes per-account claim details')
