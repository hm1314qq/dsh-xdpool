/**
 * The state document is no longer read once per process.
 *
 * Three defects motivated this, all measured on 2026-11-13:
 *
 *  1. `ensureLoaded()` read `state.json` exactly once and nothing reset
 *     `loaded`, so a hand edit (a restored backup, a removed dead credential)
 *     had no effect until the host restarted.
 *  2. The next save wrote the stale in-memory snapshot straight over the file,
 *     so the edit was not merely ignored — it was destroyed.
 *  3. Even with `account.reload` available, it needed a click.
 *
 * `pack.js` is an external build artifact and cannot be imported, so these are
 * source-shape assertions. The behaviour they describe (watcher surviving the
 * atomic tmp+rename, our own write not counting as external) is proven by
 * `tools/verify-state-watch.mjs` against a real file.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

describe('the state document can be re-read without a restart', () => {
  it('exposes a reload entry point and an RPC for it', () => {
    expect(pack).toContain('reloadFromStore() {')
    expect(pack).toContain('case "account.reload": {')
    expect(pack).toContain('pool.reloadFromStore()')
  })

  it('replaces every in-memory copy, not just the account list', () => {
    // A half-reload would leave the model blacklist or gateway flag stale while
    // the accounts looked fresh — the worst of both.
    const body = pack.match(/reloadFromStore\(\) \{([\s\S]*?)\n  \}/u)?.[1] ?? ''
    for (const field of [
      'this.cache = state.accounts',
      'this.modelCache = state.disabledModels',
      'this.contextBudgetCache = state.contextBudgets',
      'this.selectionTouchedCache = state.selectionTouched',
      'this.gatewayEnabledCache = state.gatewayEnabled',
      'this.providerOrderCache = state.providerOrder',
    ]) {
      expect(body).toContain(field)
    }
  })

  it('refuses to empty the pool when the document is unreadable', () => {
    expect(pack).toContain('if (state === void 0) return { applied: false, reason: "unreadable" };')
  })
})

describe('an external edit is not clobbered by a later save', () => {
  it('fingerprints the document by content', () => {
    expect(pack).toContain('currentFingerprint() {')
    // mtime would miss two writes inside one timestamp tick on Windows.
    expect(pack).toContain('createHashState("sha256").update(readFileSync(path))')
  })

  it('re-reads before writing when the file moved under us', () => {
    const queue = pack.match(/queueStoreSave\(\) \{([\s\S]*?)\n  \}/u)?.[1] ?? ''
    expect(queue).toContain('this.adoptExternalChanges();')
    // The adoption must happen BEFORE the payload is snapshotted, or the stale
    // cache is what gets serialised.
    expect(queue.indexOf('adoptExternalChanges')).toBeLessThan(queue.indexOf('this.store.save'))
  })

  it('treats our own write as the new baseline', () => {
    expect(pack).toMatch(/this\.store\.save\(\{[\s\S]*?\}\);\s*\n\s*\/\/ \[xdpool-local\] store-reload: our own write becomes the new baseline\.\s*\n\s*this\.knownFingerprint = this\.currentFingerprint\(\);/u)
  })
})

describe('external edits are picked up automatically', () => {
  it('watches the file and re-arms after the atomic rename', () => {
    expect(pack).toContain('import { watch as watchStateFile } from "node:fs"')
    expect(pack).toContain('function armStateWatcher()')
    // FileStore.save() is tmp+rename; the watcher holds the old inode and must
    // be rebuilt, or the second save is never observed.
    expect(pack).toMatch(/stateWatchRetryTimer = setTimeout\(\(\) => \{[\s\S]*?armStateWatcher\(\);/u)
  })

  it('guards re-arming against a missing file', () => {
    // fs.watch throws ENOENT rather than returning a dead watcher; an uncaught
    // throw here would take the host down.
    expect(pack).toContain('if (!existsSync(stateFile)) return;')
    expect(pack).toContain('watcher.on?.("error"')
  })

  it('keeps a fingerprint poll as the safety net', () => {
    expect(pack).toContain('DSH_CHANNEL_PACK_RELOAD_POLL_MS')
    expect(pack).toContain('statePollTimer = setInterval(() => scheduleApply("poll"), pollMs)')
    expect(pack).toContain('DSH_CHANNEL_PACK_WATCH_STATE !== "0"')
  })

  it('debounces so one save is not applied several times', () => {
    expect(pack).toContain('function scheduleApply(reason)')
    expect(pack).toContain('const debounceMs = 250;')
  })

  it('never outlives the fiber', () => {
    const disposer = pack.match(/ctx\.effect\?\.\(\(\) => \(\) => \{([\s\S]*?)\}, "channel-pack: state watch"\);/u)
    expect(disposer).not.toBeNull()
    const body = disposer?.[1] ?? ''
    expect(body).toContain('stateDisposed = true')
    expect(body).toContain('clearInterval(statePollTimer)')
    expect(body).toContain('stateWatcher?.close()')
  })

  it('routes every trigger through the same adoption path', () => {
    expect(pack).toContain('pool.adoptExternalChanges?.()')
  })
})
