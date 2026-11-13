/**
 * Patch channel-pack: let the running instance pick up on-disk edits WITHOUT a
 * host restart, and stop it from silently overwriting them.
 *
 * THE PROBLEM (measured 2026-11-13)
 *
 * `ChannelPackStore.ensureLoaded()` reads `state.json` exactly once and sets
 * `loaded = true`; nothing ever resets it. So:
 *
 *   - editing `state.json` (or `.credentials.yaml`) while DSH runs had NO
 *     effect on the live instance — the account pool, model blacklist and
 *     gateway flags all kept serving the in-memory copy;
 *   - worse, the next `queueStoreSave()` wrote that stale in-memory snapshot
 *     straight over the file, so an external edit was not merely ignored, it
 *     was DESTROYED. Measured: a deleted account came back because a later
 *     save re-serialised the pre-delete list.
 *
 * THE FIX — two halves
 *
 *  1. `reloadFromStore()` re-reads the document and replaces every in-memory
 *     copy, then exposes it as the `account.reload` RPC so the card (or a
 *     script) can apply an external edit on demand.
 *
 *  2. `queueStoreSave()` fingerprints the document BEFORE it writes. If the
 *     file changed since our last read/write and we are not the ones who
 *     changed it, it re-reads first and treats the file as authoritative for
 *     anything it holds. That turns "external edit silently reverted" into
 *     "external edit wins", which is what anyone editing the file expects.
 *
 * The fingerprint is a content hash, not mtime: two writes inside the same
 * millisecond are common on Windows and mtime resolution would miss one.
 *
 * Idempotent, marked `[xdpool-local] store-reload`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] store-reload'

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

// ---------------------------------------------------------------- 0. the hash import
// The store module already imports readFileSync from node:fs; it has no crypto
// import yet. Add one beside it rather than reusing a sibling module's alias.
insertAfter(
  'import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";',
  ['import { createHash as createHashState } from "node:crypto"; // ' + MARKER],
)

// ---------------------------------------------------------------- 1. fingerprint field
insertAfter(
  '  /** 是否已完成首次载入。 */',
  [
    '  // ' + MARKER + ': content hash of the document we last read or wrote.',
    '  // `null` means "unknown" (first run, memory backend, or a read failure),',
    '  // and an unknown fingerprint never blocks a write.',
    '  knownFingerprint = null;',
  ],
)

// ensureLoaded must remember the fingerprint it loaded. Anchor on the unique
// `loadLocks(state)` line that closes ensureLoaded's read block.
{
  const anchor = '    this.loadLocks(state);'
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === anchor) hits.push(i)
  if (hits.length === 0) throw new Error('loadLocks(state) not found')
  // ensureLoaded's call is the FIRST one (the class body defines it above reload).
  lines.splice(hits[0] + 1, 0, '    // ' + MARKER + ': remember what we loaded, so an external edit is detectable.', '    this.knownFingerprint = this.currentFingerprint();')
}

// ---------------------------------------------------------------- 2. fingerprint helpers + reload
// Anchor on the unique doc line that starts the writeAccounts block, then walk
// back one line to land before its `/**` opener.
{
  const docLine = '   * 持久化账号列表（同时更新进程内权威副本）。'
  const docIndex = lines.findIndex(line => line === docLine)
  if (docIndex === -1) throw new Error('writeAccounts doc line not found')
  const openIndex = docIndex - 1
  if (lines[openIndex] !== '  /**') throw new Error('unexpected block opener at ' + String(openIndex + 1))
  lines.splice(openIndex, 0, ...[
  '  // ' + MARKER + ': hash the document as it exists on disk RIGHT NOW.',
  '  //',
  '  // Content, not mtime: save() is a tmp+rename atomic write and two of them',
  '  // can land inside one filesystem timestamp tick on Windows.',
  '  currentFingerprint() {',
  '    if (this.store.kind === "memory") return null;',
  '    const path = this.store.path;',
  '    if (typeof path !== "string") return null;',
  '    try {',
  '      return createHashState("sha256").update(readFileSync(path)).digest("hex");',
  '    } catch {',
  '      // Missing file (first run) or unreadable: unknown, do not block writes.',
  '      return null;',
  '    }',
  '  }',
  '  /**',
  '   * Re-read the state document and replace every in-memory copy.',
  '   *',
  '   * Exposed as `account.reload`. It exists because a user who edits',
  '   * `state.json` (or restores a backup, or removes a dead credential by hand)',
  '   * currently has to restart the whole host for the change to be seen — and',
  '   * before this patch a later save would have reverted it anyway.',
  '   *',
  '   * Best effort by contract: an unreadable or absent document leaves the',
  '   * current copy in place and reports it, rather than emptying the pool.',
  '   */',
  '  reloadFromStore() {',
  '    if (this.store.kind === "memory") return { applied: false, reason: "memory-store" };',
  '    const state = this.store.load();',
  '    if (state === void 0) return { applied: false, reason: "unreadable" };',
  '    this.cache = state.accounts;',
  '    this.modelCache = state.disabledModels;',
  '    this.contextBudgetCache = state.contextBudgets ?? {};',
  '    this.selectionTouchedCache = state.selectionTouched ?? {};',
  '    this.gatewayEnabledCache = state.gatewayEnabled !== false;',
  '    this.providerOrderCache = state.providerOrder ?? [];',
  '    this.loadLocks(state);',
  '    this.loaded = true;',
  '    this.knownFingerprint = this.currentFingerprint();',
  '    return { applied: true, accounts: this.cache.length };',
  '  }',
  '',
  ])
}

// ---------------------------------------------------------------- 3. do not clobber an external edit
insertBefore('  queueStoreSave() {', [
  '  // ' + MARKER + ': if the file changed under us, re-read before writing.',
  '  //',
  '  // Without this, a hand-edited `state.json` is not just ignored — the next',
  '  // save re-serialises the stale in-memory copy over it and the edit is gone.',
  '  // Taking the file as authoritative for an UNTRACKED external change is the',
  '  // behaviour anyone editing it expects.',
  '  adoptExternalChanges() {',
  '    const now = this.currentFingerprint();',
  '    if (now === null) return false;',
  '    if (this.knownFingerprint === null) {',
  '      // First observation: adopt it as the baseline without touching memory.',
  '      this.knownFingerprint = now;',
  '      return false;',
  '    }',
  '    if (now === this.knownFingerprint) return false;',
  '    const result = this.reloadFromStore();',
  '    this.ctx?.logger?.warn?.(`[channel-pack] ' + ESC('检测到 state.json 被外部修改，已重新读取后再写，避免覆盖') + '`);',
  '    return result.applied === true;',
  '  }',
  '',
])

replaceBlock(
  '  queueStoreSave() {',
  19,
  [
    '  queueStoreSave() {',
    '    if (this.store.kind === "memory") return Promise.resolve();',
    '    // ' + MARKER + ': re-read first when the file changed under us.',
    '    this.adoptExternalChanges();',
    '    const next = this.storeChain.then(async () => {',
    '      await this.store.save({',
    '        accounts: this.cache,',
    '        disabledModels: this.modelCache,',
    '        contextBudgets: this.contextBudgetCache,',
    '        selectionTouched: this.selectionTouchedCache,',
    '        ...this.lockFields(),',
    '        gatewayEnabled: this.gatewayEnabledCache,',
    '        providerOrder: this.providerOrderCache',
    '      });',
    '      // ' + MARKER + ': our own write becomes the new baseline.',
    '      this.knownFingerprint = this.currentFingerprint();',
    '    });',
    '    this.storeChain = next.catch(() => {',
    '    });',
    '    return next;',
    '  }',
  ],
)

// ---------------------------------------------------------------- 4. the RPC
insertBefore('      case "account.delete": {', [
  '      // ' + MARKER + ': apply an on-disk edit WITHOUT restarting the host.',
  '      case "account.reload": {',
  '        const result = pool.reloadFromStore();',
  '        return { ok: true, value: result };',
  '      }',
])

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('knownFingerprint = null;')) throw new Error('fingerprint field missing')
if (!text.includes('currentFingerprint() {')) throw new Error('fingerprint helper missing')
if (!text.includes('reloadFromStore() {')) throw new Error('reload missing')
if (!text.includes('adoptExternalChanges() {')) throw new Error('adopt missing')
if (!text.includes('case "account.reload": {')) throw new Error('RPC branch missing')
if (!text.includes("return createHashState(\"sha256\")")) throw new Error('hash not wired')
writeFileSync(PATH, text)
console.log('patched: store reload + external-change adoption (no restart needed)')
