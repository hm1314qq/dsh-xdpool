/**
 * Patch channel-pack: make an external edit to `state.json` take effect
 * AUTOMATICALLY, without a click and without a restart.
 *
 * The previous patch added `reloadFromStore()` (exposed as `account.reload`)
 * plus "re-read before writing". That fixed the destructive half — a stale
 * in-memory copy no longer overwrites a hand edit — but the user still had to
 * press a button, and the write-path hook only fires when something else
 * happens to save.
 *
 * This patch adds the missing automatic half, in the two forms that fail
 * differently, so one covers the other:
 *
 *  1. `fs.watch` on the state file — sub-second response.
 *     ⚠ `FileStore.save()` writes `state.json.tmp` and renames it over the
 *     real file. A watcher holds the OLD inode, so after the first rename it
 *     stops reporting. The handler therefore RE-ARMS itself whenever it fires
 *     and whenever the watched path disappears, and it watches the DIRECTORY
 *     as well (a rename surfaces as a directory event on some platforms).
 *
 *  2. A fingerprint poll (default 8 s) — the safety net.
 *     If the watcher dies, is unsupported, or misses a rename on this
 *     filesystem, the poll still notices the content hash changed. It reuses
 *     `currentFingerprint()`, which is the same check the write path uses, so
 *     there is exactly one definition of "the file changed".
 *
 * Both funnel into `applyExternalChange()`, which debounces (an editor can fire
 * several events for one save) and only reloads when the hash actually moved.
 *
 * Configuration (env, both optional):
 *   DSH_CHANNEL_PACK_WATCH_STATE=0        disable the watcher
 *   DSH_CHANNEL_PACK_RELOAD_POLL_MS=8000  poll interval; 0 disables the poll
 *
 * Idempotent, marked `[xdpool-local] state-watch`.
 * Run AFTER patch-pack-state-reload.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'vendor/channel-pack/pack.js'
const MARKER = '[xdpool-local] state-watch'

const source = readFileSync(PATH, 'utf8')
if (source.includes(MARKER)) {
  console.log('already patched')
  process.exit(0)
}

const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const lines = source.split(/\r?\n/)

function insertAfter(anchor, block) {
  const index = lines.findIndex(line => line === anchor)
  if (index === -1) throw new Error('anchor not found: ' + anchor.slice(0, 90))
  lines.splice(index + 1, 0, ...block)
}

const ESC = (s) => s.replace(/[^\x20-\x7e]/gu, ch => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))

// ---------------------------------------------------------------- 1. fs.watch import
insertAfter(
  'import { createHash as createHashState } from "node:crypto"; // ' + '[xdpool-local] store-reload',
  ['import { watch as watchStateFile } from "node:fs"; // ' + MARKER],
)

// ---------------------------------------------------------------- 2. the watcher + poll
// Placed right after the pool is constructed: that is the first point where
// both `ctx` (for `effect`/`logger`) and the store-backed `pool` exist.
insertAfter(
  '  const pool = new AccountPool(ctx);',
  [
    '  // ' + MARKER + ': apply external state.json edits automatically.',
    '  //',
    '  // Two triggers on purpose, because they fail differently:',
    '  //   - fs.watch answers in well under a second but dies on the atomic',
    '  //     rename that save() performs (watcher keeps the old inode),',
    '  //   - the poll is slower but cannot be defeated by rename semantics.',
    '  // Both call the same debounced applier, which only acts when the content',
    '  // hash actually changed — so running both costs nothing extra.',
    '  let stateWatchRetryTimer;',
    '  let statePollTimer;',
    '  let stateApplyTimer;',
    '  let stateWatcher;',
    '  let stateDisposed = false;',
    '  const stateFile = pool.store?.path;',
    '  const debounceMs = 250;',
    '  const pollMs = (() => {',
    '    const raw = process.env.DSH_CHANNEL_PACK_RELOAD_POLL_MS;',
    '    if (typeof raw !== "string" || raw.trim() === "") return 8e3;',
    '    const parsed = Number(raw.trim());',
    '    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8e3;',
    '  })();',
    '  function applyExternalChange(reason) {',
    '    if (stateDisposed) return;',
    '    try {',
    '      const applied = pool.adoptExternalChanges?.();',
    '      if (applied === true) ctx.logger?.info?.(`[channel-pack] ' + ESC('已自动读取外部修改的 state.json（') + '${reason}）`);',
    '    } catch (error) {',
    '      ctx.logger?.warn?.(`[channel-pack] ' + ESC('自动读取 state.json 失败') + ': ${String(error)}`);',
    '    }',
    '  }',
    '  function scheduleApply(reason) {',
    '    if (stateDisposed) return;',
    '    if (stateApplyTimer !== void 0) clearTimeout(stateApplyTimer);',
    '    stateApplyTimer = setTimeout(() => {',
    '      stateApplyTimer = void 0;',
    '      applyExternalChange(reason);',
    '    }, debounceMs);',
    '    stateApplyTimer.unref?.();',
    '  }',
    '  /** (Re)arm the watcher. Called at start and after every rename. */',
    '  function armStateWatcher() {',
    '    if (stateDisposed || stateFile === void 0) return;',
    '    try {',
    '      stateWatcher?.close();',
    '    } catch {}',
    '    stateWatcher = void 0;',
    '    try {',
    '      // The file may be mid-replace (or genuinely gone). `fs.watch` throws',
    '      // ENOENT rather than returning a dead watcher, and an uncaught throw',
    '      // here would take the whole host down — so this stays inside the try',
    '      // and simply retries on the next poll.',
    '      if (!existsSync(stateFile)) return;',
    '      const watcher = watchStateFile(stateFile, { persistent: false }, () => {',
    '        scheduleApply("watch");',
    '        // The rename replacing state.json invalidates this watcher\'s inode.',
    '        // Re-arm on the next tick so the following save is still observed.',
    '        if (stateWatchRetryTimer !== void 0) clearTimeout(stateWatchRetryTimer);',
    '        stateWatchRetryTimer = setTimeout(() => {',
    '          stateWatchRetryTimer = void 0;',
    '          armStateWatcher();',
    '        }, 500);',
    '        stateWatchRetryTimer.unref?.();',
    '      });',
    '      watcher.on?.("error", () => {',
    '        try { watcher.close(); } catch {}',
    '        if (stateDisposed) return;',
    '        // Never leave the state silent: re-arm once, then rely on the poll.',
    '        if (stateWatchRetryTimer !== void 0) clearTimeout(stateWatchRetryTimer);',
    '        stateWatchRetryTimer = setTimeout(() => {',
    '          stateWatchRetryTimer = void 0;',
    '          armStateWatcher();',
    '        }, 2e3);',
    '        stateWatchRetryTimer.unref?.();',
    '      });',
    '      watcher.unref?.();',
    '      stateWatcher = watcher;',
    '    } catch (error) {',
    '      ctx.logger?.warn?.(`[channel-pack] ' + ESC('无法监听 state.json，改用轮询') + ': ${String(error)}`);',
    '    }',
    '  }',
    '  if (stateFile !== void 0 && process.env.DSH_CHANNEL_PACK_WATCH_STATE !== "0") armStateWatcher();',
    '  if (stateFile !== void 0 && pollMs > 0) {',
    '    statePollTimer = setInterval(() => scheduleApply("poll"), pollMs);',
    '    statePollTimer.unref?.();',
    '  }',
    '  ctx.effect?.(() => () => {',
    '    // ' + MARKER + ': never outlive the fiber.',
    '    stateDisposed = true;',
    '    if (stateApplyTimer !== void 0) clearTimeout(stateApplyTimer);',
    '    if (stateWatchRetryTimer !== void 0) clearTimeout(stateWatchRetryTimer);',
    '    if (statePollTimer !== void 0) clearInterval(statePollTimer);',
    '    try { stateWatcher?.close(); } catch {}',
    '  }, "channel-pack: state watch");',
  ],
)

// ---------------------------------------------------------------- verify
const text = lines.join(EOL)
if (!text.includes(MARKER)) throw new Error('marker did not land')
if (!text.includes('import { watch as watchStateFile }')) throw new Error('fs.watch import missing')
if (!text.includes('function armStateWatcher()')) throw new Error('watcher missing')
if (!text.includes('function scheduleApply(reason)')) throw new Error('debounce missing')
if (!text.includes('DSH_CHANNEL_PACK_RELOAD_POLL_MS')) throw new Error('poll override missing')
if (!text.includes('"channel-pack: state watch"')) throw new Error('disposer missing')
if (!text.includes('pool.adoptExternalChanges?.()')) throw new Error('not wired to the reload path')
writeFileSync(PATH, text)
console.log('patched: state.json edits apply automatically (fs.watch + fingerprint poll)')
