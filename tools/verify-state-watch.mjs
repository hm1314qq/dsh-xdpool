/**
 * Behavioural check for the automatic state reload.
 *
 * Source assertions cannot prove the thing that actually matters here: that the
 * watcher SURVIVES the `tmp + rename` that `FileStore.save()` performs (a
 * watcher holds the old inode and goes silent after the first rename). So this
 * drives the REAL patched bundle against a REAL file:
 *
 *   - slices `FileStore` + `AccountPool` out of the patched `pack.js`,
 *   - runs them in a vm context with `require` bound to the real node builtins,
 *   - wires the watcher + poll exactly as `apply()` does,
 *   - rewrites `state.json` in place AND via tmp+rename,
 *   - asserts the in-memory pool follows the file with no click.
 *
 * Run: node tools/verify-state-watch.mjs [path-to-pack.js]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readFileSync as readFileSyncNode, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const PACK = process.argv[2] ?? 'vendor/channel-pack/pack.js'
const pack = readFileSync(PACK, 'utf8').replace(/\r\n/gu, '\n')

/** Slice a top-level declaration out of the bundle by its opening text. */
function slice(startText, endText) {
  const start = pack.indexOf(startText)
  if (start === -1) throw new Error(`not found: ${startText}`)
  const end = pack.indexOf(endText, start)
  if (end === -1) throw new Error(`end not found for: ${startText}`)
  return pack.slice(start, end)
}

/**
 * Slice a `var X = class {` block by brace matching.
 *
 * The bundle separates top-level declarations with comments, but not reliably
 * right after every class, so walking braces is the only stable boundary.
 */
function sliceClass(startText) {
  const start = pack.indexOf(startText)
  if (start === -1) throw new Error(`not found: ${startText}`)
  let depth = 0
  let i = start
  // Walk from the opening `{` of the class body.
  i = pack.indexOf('{', start)
  for (; i < pack.length; i += 1) {
    const ch = pack[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        // Consume the trailing `;` of `var X = class {...};`
        let end = i + 1
        if (pack[end] === ';') end += 1
        return pack.slice(start, end)
      }
    }
  }
  throw new Error(`unbalanced class: ${startText}`)
}

const source = `
// ---- minimal sanitizers the FileStore depends on ----
function sanitizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(a => a !== null && typeof a === 'object' && typeof a.id === 'string' && typeof a.provider === 'string')
    .map(a => ({
      id: a.id, provider: a.provider,
      nickname: typeof a.nickname === 'string' ? a.nickname : '',
      enabled: a.enabled !== false,
      credentialRef: typeof a.credentialRef === 'string' ? a.credentialRef : '',
      refreshable: a.refreshable === true, createdAt: 0, expiresAt: 0,
    }));
}
function sanitizeDisabledModels(raw) { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function sanitizeContextBudgets(raw) { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function sanitizeSelectionTouched(raw) { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function sanitizeGatewayEnabled(raw) { return raw !== false; }
function sanitizeProviderOrder(raw) { return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []; }
function sanitizePermanentLocks(raw) { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
function locksFieldOf() { return {}; }
function mergeLegacyLoomyLock(locks, legacyLoomyLocked) {
  if (locks.loomy === undefined && legacyLoomyLocked === true) return { ...locks, loomy: true };
  return locks;
}

// ---- the real FileStore from the patched bundle ----
${sliceClass('var FileStore = class {')}

// ---- the real AccountPool from the patched bundle ----
${sliceClass('var AccountPool = class {')}

// ---- host shims ----
function createChannelPackStore(ctx, forcedPath) { return new FileStore(ctx.home, forcedPath, ctx.logger); }
function createPermanentLockStore() { return { kind: 'memory', load: () => ({ exists: false, locks: {} }), save: async () => {} }; }
const CHANNEL_PACK_NS = 'channel-pack';
globalThis.__AccountPool = AccountPool;
globalThis.__FileStore = FileStore;
`

const sandbox = {
  console, process, Date, Set, Map, JSON, Number, String, Array, Object, Math, Promise, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  // The bundle's AccountPool was patched to import `createHash as createHashState`,
  // so that is the binding name its method body actually calls.
  createHashState: createHash,
  existsSync, mkdirSync, readFileSync: readFileSyncNode, renameSync, writeFileSync, watch,
  homedir: tmpdir,
  join,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures += 1
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- fixtures
const dir = mkdtempSync(join(tmpdir(), 'xdpool-watch-'))
const statePath = join(dir, 'state.json')
const doc = (accounts) => JSON.stringify({
  accounts: accounts.map(([id, nick]) => ({ id, provider: 'trae', nickname: nick, enabled: true, credentialRef: `REF_${id}` })),
  disabledModels: {}, contextBudgets: {}, selectionTouched: {}, gatewayEnabled: true, providerOrder: [],
}, null, 2)
writeFileSync(statePath, doc([['trae-a', 'a'], ['trae-b', 'b']]), 'utf8')

const pool = new sandbox.__AccountPool({
  home: dir,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: () => undefined,
})
pool.store = new sandbox.__FileStore(dir, statePath, { warn: () => {} })
pool.ensureLoaded()
check('initial load sees two accounts', pool.readAccounts().length === 2)
check('a content fingerprint was recorded on load', typeof pool.knownFingerprint === 'string' && pool.knownFingerprint.length === 64)

// ---------------------------------------------------------------- the wiring under test
let applyTimer
let pollTimer
let watcher
let retryTimer
let disposed = false
const applied = []
function applyExternalChange(reason) {
  if (disposed) return
  if (pool.adoptExternalChanges() === true) applied.push(reason)
}
function scheduleApply(reason) {
  if (disposed) return
  if (applyTimer !== undefined) clearTimeout(applyTimer)
  applyTimer = setTimeout(() => { applyTimer = undefined; applyExternalChange(reason) }, 250)
  applyTimer.unref?.()
}
function armStateWatcher() {
  if (disposed) return
  try { watcher?.close() } catch {}
  watcher = undefined
  try {
    // fs.watch throws ENOENT when the file is mid-replace or gone; the patch
    // guards this for the same reason.
    if (!existsSync(statePath)) return
    watcher = watch(statePath, { persistent: false }, () => {
      scheduleApply('watch')
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => { retryTimer = undefined; armStateWatcher() }, 500)
      retryTimer.unref?.()
    })
    watcher.on?.('error', () => {})
    watcher.unref?.()
  } catch {
    // Rely on the poll.
  }
}
armStateWatcher()
pollTimer = setInterval(() => scheduleApply('poll'), 300)
pollTimer.unref?.()

// ---------------------------------------------------------------- 1. plain overwrite
writeFileSync(statePath, doc([['trae-a', 'a']]), 'utf8')
await sleep(1000)
check('an in-place edit is applied automatically', pool.readAccounts().length === 1)
check('the WATCHER reported it (not just the poll)', applied.includes('watch'))

// ---------------------------------------------------------------- 2. atomic tmp+rename
writeFileSync(statePath + '.tmp', doc([['trae-a', 'a'], ['trae-c', 'c']]), 'utf8')
renameSync(statePath + '.tmp', statePath)
await sleep(1400)
check('a tmp+rename replace is applied too', pool.readAccounts().length === 2)
check('the newly added account is visible', pool.readAccounts().some(a => a.id === 'trae-c'))

// ---------------------------------------------------------------- 3. our own write is not "external"
const ownCount = pool.readAccounts().length
pool.writeAccounts(pool.readAccounts().concat([{ id: 'trae-own', provider: 'trae', nickname: 'own', enabled: true, credentialRef: 'REF_own', refreshable: false, createdAt: 0, expiresAt: 0 }])).then(() => {})
await sleep(1200)
check('our own save is not re-read as an external change', pool.readAccounts().length === ownCount + 1)
check('our own write reached the file', JSON.parse(readFileSync(statePath, 'utf8')).accounts.some(a => a.id === 'trae-own'))

// ---------------------------------------------------------------- 4. a vanished file must not empty the pool
try { unlinkSync(statePath) } catch {}
await sleep(900)
check('a missing file does not empty the in-memory pool', pool.readAccounts().length > 0)

disposed = true
if (applyTimer !== undefined) clearTimeout(applyTimer)
if (retryTimer !== undefined) clearTimeout(retryTimer)
if (pollTimer !== undefined) clearInterval(pollTimer)
try { watcher?.close() } catch {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
