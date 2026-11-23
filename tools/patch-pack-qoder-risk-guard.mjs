/**
 * Patch channel-pack: handle qoder/qodercn RISK CONTROL as a first-class failure.
 *
 * WHY
 *
 * Two measured behaviours made qoder/qodercn unusable under risk control:
 *
 *  1. A 401/403 that SURVIVES a token refresh is the gateway's risk gate refusing
 *     the account — the token was minted seconds ago, so the credential is fine.
 *     The adapter treated it as a plain `AUTH` error: no cooldown, no rotation, so
 *     the next turn picked the same account and hit the same wall (issue #181:
 *     "同一批账号全部排队等待中").
 *  2. A risk-gated account is PARKED in the model queue: the server answers the
 *     queue shape with a multi-minute `retryAfterSeconds`, and the adapter held
 *     the turn for up to `resolveQueueTimeoutMs()` (30 min) waiting — one turn
 *     frozen, other accounts never tried.
 *
 * And a trigger-side gap: nothing spaces request STARTS on one account, so
 * parallel DSH turns burst the same credential — exactly the pattern risk gates
 * flag.
 *
 * THE FIX
 *
 *  1. Account-level risk cooldown: `setAccountRiskCooldown(id, until, reason)`
 *     writes `riskCooldownUntil` / `riskCooldownReason` on the account row.
 *     `getAvailableAccount` filters cooling accounts out, so the first pick AND
 *     every rotation skip them. Longer-wins semantics; expired markers are inert
 *     (no sweep needed).
 *  2. In the adapter's 401/403 branch: after the one-shot token refresh fails to
 *     clear it, cool the ACCOUNT for `DSH_QODER_RISK_COOLDOWN_MS` (default 30
 *     min) and rotate to the next account; when the pool is empty, report the
 *     remaining minutes instead of a bare AUTH error.
 *  3. Queue parking: a queue wait ≥ `DSH_QODER_QUEUE_PARK_MS` (default 2 min)
 *     cools the account and rotates instead of holding the turn — on both the
 *     HTTP queue shape and the SSE `ModelQueuedError` shape.
 *  4. Per-account pacing: request STARTS on one account are spaced by
 *     `DSH_QODER_ACCOUNT_GAP_MS` (+ jitter, default 2s) without serializing
 *     streams — a long turn never blocks the next turn.
 *
 * Every knob is env-overridable, so a reported gate can be tuned without a new
 * build. Idempotent, marked `[xdpool-local] qoder-risk-guard`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] qoder-risk-guard'

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
/** Index of the first line after `from` matching `predicate` (relative locators for duplicated shapes). */
function findAfter(from, predicate) {
  for (let i = from; i < lines.length; i += 1) {
    if (predicate(lines[i], i)) return i
  }
  throw new Error('no match after line ' + String(from + 1))
}

const ESC = (s) => s.replace(/[^\x20-\x7e]/gu, ch => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))

// ---------------------------------------------------------- 1. pool: account-level cooldown
insertBefore('  async updateModelRateLimit(accountId, modelId, resetAtMs) {', [
  '  // ' + MARKER + ': an ACCOUNT-level risk cooldown (see the adapter for why a risk',
  '  // gate is not a per-model rate limit: the gateway refuses the account, not the',
  '  // model). `getAvailableAccount` filters on it; longer-wins like',
  '  // updateModelRateLimit; expired markers are inert, so no sweep is needed.',
  '  async setAccountRiskCooldown(accountId, untilMs, reason) {',
  '    const accounts = this.readAccounts();',
  '    const idx = accounts.findIndex((a) => a.id === accountId);',
  '    if (idx === -1) return;',
  '    if (!Number.isFinite(untilMs)) return;',
  '    const next = [...accounts];',
  '    const entry = { ...next[idx] };',
  '    entry.riskCooldownUntil = untilMs;',
  '    entry.riskCooldownReason = typeof reason === "string" ? reason.slice(0, 200) : "";',
  '    next[idx] = entry;',
  '    await this.writeAccounts(next);',
  '    this.ctx.logger?.info?.(`[channel-pack] ${RISK_COOLDOWN_LOG}: ${accountId} ${RISK_RECOVERS_AT_LOG} ${new Date(untilMs).toISOString()}`);',
  '  }',
  '',
])

// ---------------------------------------------------------- 2. pool: the candidate filter
replaceBlock(
  '    const candidates = this.readAccounts().filter((a) => a.provider === provider && a.enabled).filter((a) => excludeAccountIds === void 0 || !excludeAccountIds.has(a.id)).filter((a) => {',
  1,
  [
    '    // ' + MARKER + ': risk-cooled accounts are invisible to every picker, including the',
    '    // first pick (`resolveCredential` walks the same pool) — not only to rotations.',
    '    const candidates = this.readAccounts().filter((a) => a.provider === provider && a.enabled).filter((a) => !(Number.isFinite(a.riskCooldownUntil) && a.riskCooldownUntil > Date.now())).filter((a) => excludeAccountIds === void 0 || !excludeAccountIds.has(a.id)).filter((a) => {',
  ],
)

// ---------------------------------------------------------- 3. knobs, the pacing gate, the park helper
insertBefore('var QODER_REQUEST_TIMEOUT_MS = 3e4;', [
  '// ' + MARKER + ': account-level risk handling knobs (all env-overridable).',
  '//',
  '//   DSH_QODER_RISK_COOLDOWN_MS  how long a risk-flagged account sits out (30 min)',
  '//   DSH_QODER_QUEUE_PARK_MS     a queue wait longer than this reads as parking (2 min)',
  '//   DSH_QODER_ACCOUNT_GAP_MS    min gap between request STARTS on one account (2s, 0 = off)',
  'function qoderEnvMs(name, fallback) {',
  '  const raw = process.env[name];',
  '  if (raw === void 0 || raw.length === 0) return fallback;',
  '  const parsed = Number.parseInt(raw, 10);',
  '  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;',
  '}',
  'var QODER_RISK_COOLDOWN_MS = qoderEnvMs("DSH_QODER_RISK_COOLDOWN_MS", 18e5);',
  'var QODER_QUEUE_PARK_MS = qoderEnvMs("DSH_QODER_QUEUE_PARK_MS", 12e4);',
  'var QODER_ACCOUNT_MIN_GAP_MS = qoderEnvMs("DSH_QODER_ACCOUNT_GAP_MS", 2e3);',
  'var QODER_ACCOUNT_JITTER_MS = 500;',
  'var RISK_COOLDOWN_LOG = \'' + ESC('风控冷却') + '\';',
  'var RISK_RECOVERS_AT_LOG = \'' + ESC('恢复于') + '\';',
  'var QODER_RISK_MSG_HEAD = \'' + ESC('风控冷却中') + '\';',
  'var QODER_RISK_MSG_RECOVER = \'' + ESC('约需') + '\';',
  'var QODER_RISK_MSG_MIN = \'' + ESC('分钟后自动恢复') + '\';',
  'var QODER_RISK_MSG_EXHAUSTED = \'' + ESC('（池内没有其它可用账号）') + '\';',
  '/** A queue wait this long is the risk gate parking the account, not a busy model. */',
  'function qoderQueueParkMs(info) {',
  '  if (info === void 0) return void 0;',
  '  const seconds = readFiniteNumber(info.retryAfterSeconds);',
  '  const ms = readFiniteNumber(info.retry_after_ms) ?? (seconds === void 0 ? void 0 : seconds * 1000);',
  '  if (ms === void 0 || ms < QODER_QUEUE_PARK_MS) return void 0;',
  '  return ms;',
  '}',
  '/** One human sentence for a risk-cooled account, with the remaining minutes. */',
  'function qoderRiskMessage(accountId, waitMin, reason, exhausted) {',
  '  const who = accountId !== void 0 && accountId.length > 0 ? " " + accountId : "";',
  '  const why = reason === "" ? "" : " \\u2014 " + reason;',
  '  const tail = exhausted === true ? " " + QODER_RISK_MSG_EXHAUSTED : "";',
  '  return "qoder: " + QODER_RISK_MSG_HEAD + who + " " + QODER_RISK_MSG_RECOVER + " " + String(waitMin) + " " + QODER_RISK_MSG_MIN + why + tail;',
  '}',
  '// Spaces REQUEST STARTS per account (min gap + jitter) without serializing streams:',
  '// a long turn never blocks the next turn — only their starts are spaced. Chained',
  '// per account so concurrent turns cannot race the gap. The first request on an',
  '// account starts immediately; every later one waits its turn.',
  'var qoderAccountGate = /* @__PURE__ */ new Map();',
  'function qoderAccountGateWait(accountId, signal) {',
  '  if (accountId === void 0 || accountId.length === 0) return Promise.resolve();',
  '  const previous = qoderAccountGate.get(accountId);',
  '  if (previous === void 0) {',
  '    qoderAccountGate.set(accountId, Promise.resolve(Date.now()));',
  '    return Promise.resolve();',
  '  }',
  '  const next = previous.catch(() => 0).then((lastStart) => {',
  '    const gap = QODER_ACCOUNT_MIN_GAP_MS + Math.floor(Math.random() * QODER_ACCOUNT_JITTER_MS);',
  '    return lastStart + gap;',
  '  }).then((earliest) => new Promise((resolve) => {',
  '    const timer = setTimeout(resolve, Math.max(0, earliest - Date.now()));',
  '    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(earliest); }, { once: true });',
  '  }));',
  '  qoderAccountGate.set(accountId, next);',
  '  return next;',
  '}',
  '',
])

// ---------------------------------------------------------- 4. loop top: pace every outbound attempt
insertBefore('      response = await this.sendEncrypted(await buildRequest(credential), options);', [
  '      // ' + MARKER + ': pace request starts per account. Rotations re-enter this loop,',
  '      // so rotated accounts are paced too; the first request starts immediately.',
  '      await qoderAccountGateWait(activeAccountId, options.signal);',
])

// ---------------------------------------------------------- 5. 401/403 after refresh: cool + rotate
// The bare AUTH throw right after the one-shot refresh block (unique within the
// qoder `send` region — located RELATIVE to the request loop's call site, because
// the loop PRECEDES the helper methods and the same line shape exists in other
// providers' adapters).
const loopSendIdx = lines.findIndex(l => l === '      response = await this.sendEncrypted(await buildRequest(credential), options);')
if (loopSendIdx === -1) throw new Error('qoder loop call site not found')
const expiredThrowIdx = findAfter(loopSendIdx, (l) => l.includes('qoder: credential expired and refresh failed'))
const bareThrowIdx = findAfter(expiredThrowIdx, (l) => l === '        throw new LlmError7(`qoder: ${errorDetail4(errorText)}`, httpErrorCode4(response.status), { status: response.status });')
lines.splice(bareThrowIdx, 1, ...[
  '        // ' + MARKER + ': a 401/403 that SURVIVES a token refresh is the risk gate',
  '        // refusing this account — the token was minted seconds ago, so the',
  '        // credential is fine and refreshing again is pointless. Cool the ACCOUNT',
  '        // (the gate does not care which model was asked) and rotate to the next',
  '        // account; when the pool is empty, report the remaining minutes instead',
  '        // of a bare AUTH error the next turn would hit again on the same account.',
  '        const riskUntil = Date.now() + QODER_RISK_COOLDOWN_MS;',
  '        const riskReason = errorDetail4(errorText);',
  '        const riskHasAccount = activeAccountId !== void 0 && activeAccountId.length > 0;',
  '        if (this.options.accountPool !== void 0 && riskHasAccount) {',
  '          await this.options.accountPool.setAccountRiskCooldown(activeAccountId, riskUntil, riskReason);',
  '        }',
  '        const rotated = riskHasAccount ? await this.rotateOnRisk(options, triedAccounts) : void 0;',
  '        if (rotated !== void 0) {',
  '          credential = rotated.credential;',
  '          activeAccountId = rotated.accountId;',
  '          authRefreshed = false;',
  '          continue;',
  '        }',
  '        const riskWaitMin = Math.max(1, Math.ceil((riskUntil - Date.now()) / 60000));',
  '        throw new LlmError7(qoderRiskMessage(activeAccountId, riskWaitMin, riskReason, riskHasAccount), httpErrorCode4(response.status), { status: response.status });',
])

// ---------------------------------------------------------- 6. queue parking, HTTP shape
replaceBlock('        const queueInfo = parseQoderQueueError(errorText);', 5, [
  '          const queueInfo = parseQoderQueueError(errorText);',
  '          if (queueInfo !== void 0) {',
  '            // ' + MARKER + ': a queue slot this long is the risk gate parking the',
  '            // account — cool it and rotate instead of holding the turn (and the',
  '            // queue deadline) for the whole park. Short waits keep waiting.',
  '            const parkedMs = qoderQueueParkMs(queueInfo);',
  '            if (parkedMs !== void 0 && riskHasAccountCheck(activeAccountId)) {',
  '              await this.options.accountPool?.setAccountRiskCooldown(activeAccountId, Date.now() + QODER_RISK_COOLDOWN_MS, `' + ESC('排队') + ' ${String(Math.round(parkedMs / 1000))}s`);',
  '              const rotatedPark = await this.rotateOnRisk(options, triedAccounts);',
  '              if (rotatedPark !== void 0) {',
  '                credential = rotatedPark.credential;',
  '                activeAccountId = rotatedPark.accountId;',
  '                authRefreshed = false;',
  '                continue;',
  '              }',
  '            }',
  '            await this.waitForQueue(queueInfo, ++queueAttempts, queueDeadline, options);',
  '            continue;',
  '          }',
])

// ---------------------------------------------------------- 7. queue parking, SSE shape
insertAfter('          if (error instanceof ModelQueuedError) {', [
  '            // ' + MARKER + ': same parking rule as the HTTP layer above.',
  '            const parkedMsSse = qoderQueueParkMs(queueInfoOf(error));',
  '            if (parkedMsSse !== void 0 && riskHasAccountCheck(activeAccountId)) {',
  '              await this.options.accountPool?.setAccountRiskCooldown(activeAccountId, Date.now() + QODER_RISK_COOLDOWN_MS, `' + ESC('排队') + ' ${String(Math.round(parkedMsSse / 1000))}s`);',
  '              const rotatedSse = await this.rotateOnRisk(options, triedAccounts);',
  '              if (rotatedSse !== void 0) {',
  '                credential = rotatedSse.credential;',
  '                activeAccountId = rotatedSse.accountId;',
  '                authRefreshed = false;',
  '                queued = true;',
  '                break;',
  '              }',
  '            }',
])

// ---------------------------------------------------------- 8. rotateOnRisk: rotation WITHOUT a model-rate-limit write
// Inserted after the qoder `switchAccountOnQuota` method (its FIRST definition in
// the file belongs to this adapter). Located by CONTAINS (the actual indentation
// differs between the bundled classes), and the method end is the signature's
// own indent + '}'.
const switchIdx = lines.findIndex(l => l.includes('async switchAccountOnQuota(options, tried, activeAccountId) {'))
if (switchIdx === -1) throw new Error('switchAccountOnQuota not found')
const switchIndent = lines[switchIdx].match(/^\s*/u)[0]
const switchEnd = findAfter(switchIdx + 1, (l) => l === switchIndent + '}')
lines.splice(switchEnd + 1, 0, ...[
  '  /** ' + MARKER + ': rotate like switchAccountOnQuota, but WITHOUT writing a model',
  '    * rate limit — a risk gate cools the account (setAccountRiskCooldown above),',
  '    * not one model until midnight. */',
  '  async rotateOnRisk(options, tried) {',
  '    const pool = this.options.accountPool;',
  '    if (pool === void 0) return void 0;',
  '    const next = await pool.getAvailableAccount(this.product.id, options.model, tried);',
  '    if (next === null || tried.has(next.entry.id)) return void 0;',
  '    tried.add(next.entry.id);',
  '    return { credential: await this.ensureUid(next.credential), accountId: next.entry.id };',
  '  }',
])

// ---------------------------------------------------------- 9. the riskHasAccountCheck helper
// Defined once, used by both park branches (inserted before the constants block).
insertBefore('function qoderEnvMs(name, fallback) {', [
  'function riskHasAccountCheck(accountId) {',
  '  return accountId !== void 0 && accountId.length > 0;',
  '}',
])

// ---------------------------------------------------------- verify
const text = lines.join(EOL)
const markerCount = text.split(MARKER).length - 1
if (markerCount < 8) throw new Error('marker landed ' + String(markerCount) + ' times, expected >= 8')
if (!text.includes('async setAccountRiskCooldown(accountId, untilMs, reason)')) throw new Error('pool method missing')
if (!text.includes('!(Number.isFinite(a.riskCooldownUntil) && a.riskCooldownUntil > Date.now())')) throw new Error('candidate filter missing')
if (!text.includes('function qoderQueueParkMs(info) {')) throw new Error('park helper missing')
if (!text.includes('function qoderAccountGateWait(accountId, signal) {')) throw new Error('gate missing')
if (!text.includes('await qoderAccountGateWait(activeAccountId, options.signal);')) throw new Error('pacing call site missing')
if (!text.includes('await this.options.accountPool.setAccountRiskCooldown(activeAccountId, riskUntil, riskReason);')) throw new Error('risk branch missing')
if (!text.includes('async rotateOnRisk(options, tried) {')) throw new Error('rotateOnRisk missing')
if ((text.match(/async rotateOnRisk\(options, tried\) \{/gu) ?? []).length !== 1) throw new Error('rotateOnRisk landed more than once')
if (!text.includes('const parkedMs = qoderQueueParkMs(queueInfo);')) throw new Error('http park check missing')
if (!text.includes('const parkedMsSse = qoderQueueParkMs(queueInfoOf(error));')) throw new Error('sse park check missing')
if (!text.includes('function qoderRiskMessage(accountId, waitMin, reason, exhausted) {')) throw new Error('message helper missing')
writeFileSync(PATH, text)
console.log('patched: qoder risk control cools the ACCOUNT (30 min, env-tunable), rotates instead of hammering, parks are detected in both queue shapes, and per-account request starts are paced')
