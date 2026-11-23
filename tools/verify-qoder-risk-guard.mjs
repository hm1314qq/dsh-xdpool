/**
 * Behavioural check for the qoder risk-guard patch.
 *
 * Slices the patched module-level helpers straight out of `vendor/channel-pack/
 * pack.js` (so it always tests the real artifact, never a copy), runs them in a
 * VM, and asserts the three contracts the adapter relies on:
 *
 *  1. `qoderQueueParkMs` — only a queue wait ≥ the park threshold (from
 *     `retry_after_ms` / `retryAfterSeconds`) counts as risk parking;
 *  2. `qoderAccountGateWait` — request starts on ONE account are spaced by the
 *     configured gap; different accounts do not wait on each other;
 *  3. the account-level cooldown is wired where it matters: `getAvailableAccount`
 *     filters `riskCooldownUntil`, the 401/403 fall-through cools and rotates
 *     (via `rotateOnRisk`, which never writes a per-model rate limit).
 *
 * Run: node tools/verify-qoder-risk-guard.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const pack = readFileSync('vendor/channel-pack/pack.js', 'utf8').replace(/\r\n/gu, '\n')

function slice(startMarker, endMarker) {
  const start = pack.indexOf(startMarker)
  if (start === -1) throw new Error(`start marker not found: ${startMarker.slice(0, 60)}`)
  const end = pack.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker.slice(0, 60)}`)
  return pack.slice(start, end)
}

// ---- 1. the knobs + park helper + gate, as one slice ----
const knobs = slice(
  '// [xdpool-local] qoder-risk-guard: account-level risk handling knobs',
  'var QODER_REQUEST_TIMEOUT_MS',
)

let failures = 0
function check(name, ok) {
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}`)
  if (ok !== true) failures += 1
}

const sandbox = {
  process: { env: {} },
  setTimeout,
  clearTimeout,
  Date,
  Math,
  console,
  // The bundle defines `readFiniteNumber` in an earlier module; the slice needs
  // the same semantics, so the sandbox supplies it verbatim.
  readFiniteNumber: (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0,
}
vm.createContext(sandbox)
vm.runInContext(knobs, sandbox, { timeout: 5000 })

// park threshold: only multi-minute waits count as parking.
check('park: 200s retryAfterSeconds counts as parked', vm.runInContext('qoderQueueParkMs({ retryAfterSeconds: 200 })', sandbox) === 200000)
check('park: 5s retry_after_ms does not', vm.runInContext('qoderQueueParkMs({ retry_after_ms: 5000 })', sandbox) === undefined)
check('park: no queue info does not', vm.runInContext('qoderQueueParkMs(undefined)', sandbox) === undefined)
check('park: 30s wait under the 2min default does not', vm.runInContext('qoderQueueParkMs({ retry_after_ms: 30000 })', sandbox) === undefined)

// env override changes the threshold.
const sandbox2 = { process: { env: { DSH_QODER_QUEUE_PARK_MS: '15000' } }, setTimeout, clearTimeout, Date, Math, console, readFiniteNumber: (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0 }
vm.createContext(sandbox2)
vm.runInContext(knobs, sandbox2, { timeout: 5000 })
check('park: env override lowers the threshold', vm.runInContext('qoderQueueParkMs({ retry_after_ms: 20000 })', sandbox2) === 20000)

// gate: same account is spaced; different accounts are independent.
async function gateTest() {
  const gateSandbox = { process: { env: { DSH_QODER_ACCOUNT_GAP_MS: '120' } }, setTimeout, clearTimeout, Date, Math, console, Promise }
  vm.createContext(gateSandbox)
  vm.runInContext(knobs, gateSandbox, { timeout: 5000 })
  const run = (expr) => vm.runInContext(expr, gateSandbox, { timeout: 5000 })
  const t0 = Date.now()
  await run('qoderAccountGateWait("acct-a")')
  const firstDone = Date.now() - t0
  const t1 = Date.now()
  await run('qoderAccountGateWait("acct-a")')
  const secondWait = Date.now() - t1
  // The second start waits for the gap since the first START (first call itself
  // started immediately, so the second waits roughly the gap, ± jitter).
  check(`gate: same account waits (~${String(secondWait)}ms after an immediate first)`, secondWait >= 60 && secondWait < 4000)
  check(`gate: first call on a fresh account starts immediately (~${String(firstDone)}ms)`, firstDone < 60)
  const t2 = Date.now()
  await run('qoderAccountGateWait("acct-b")')
  check(`gate: a different account starts immediately (~${String(Date.now() - t2)}ms)`, Date.now() - t2 < 60)
  const t3 = Date.now()
  await run('qoderAccountGateWait(undefined)')
  check('gate: unknown account id is a no-op', Date.now() - t3 < 10)
}
await gateTest()

// ---- 2. wiring assertions on the real artifact ----
check('pool: getAvailableAccount filters riskCooldownUntil', pack.includes('!(Number.isFinite(a.riskCooldownUntil) && a.riskCooldownUntil > Date.now())'))
check('pool: setAccountRiskCooldown writes the marker + reason', pack.includes('entry.riskCooldownUntil = untilMs;') && pack.includes('entry.riskCooldownReason ='))
check('adapter: the 401/403 fall-through cools the account', pack.includes('await this.options.accountPool.setAccountRiskCooldown(activeAccountId, riskUntil, riskReason);'))
check('adapter: rotation goes through rotateOnRisk (no model-rate-limit write)', pack.includes('const rotated = riskHasAccount ? await this.rotateOnRisk(options, triedAccounts) : void 0;') && pack.includes('async rotateOnRisk(options, tried) {'))
check('adapter: rotateOnRisk never writes a per-model rate limit', !(slice('async rotateOnRisk(options, tried) {', 'function promotionActiveNow2').includes('updateModelRateLimit')))
check('adapter: queue parking cools + rotates on the HTTP shape', pack.includes('const parkedMs = qoderQueueParkMs(queueInfo);'))
check('adapter: queue parking cools + rotates on the SSE shape', pack.includes('const parkedMsSse = qoderQueueParkMs(queueInfoOf(error));'))
check('adapter: per-account pacing call sits at the loop top', pack.includes('await qoderAccountGateWait(activeAccountId, options.signal);'))
check('adapter: the all-accounts-cooled error names the minutes', pack.includes('qoderRiskMessage(activeAccountId, riskWaitMin, riskReason, riskHasAccount)'))

if (failures > 0) {
  console.log(`\n${String(failures)} FAIL`)
  process.exit(1)
}
console.log('\nALL PASS')
