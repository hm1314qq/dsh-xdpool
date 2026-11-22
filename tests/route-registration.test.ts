import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every route the browser calls has a host registration.
 *
 * WHY THIS TEST EXISTS
 *
 * `POOL_CHANNEL_USAGE_PATH` was declared in `status-paths.ts`, fetched by
 * `ChannelPoolSection` on mount and POSTed by `ChannelUsagePane` on every click
 * — and no host route ever answered it. Both failures were silent in the way
 * that costs the most: the GET's `catch` swallowed the 404 and the pane simply
 * rendered "follows the global setting", so the feature looked like it worked
 * with nothing to configure. A click reported `HTTP 404` in a toast nobody had
 * a reason to read twice.
 *
 * This is the same class of bug `route-contract.test.ts` guards from the other
 * direction ("the client reads fields the server actually sends"). Here the
 * question is whether the server answers at all, and it is answerable from the
 * two sources without a live host.
 */

const SRC = new URL('../src/', import.meta.url)

/** Provider modules build their paths from a `paths` object, so `path:` is indirect there. */
const INDIRECT = /path:\s*paths\./u

function serverSources(): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'client') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(SRC.pathname.replace(/^\//u, ''))
  return out
}

/** Constants passed to `ctx.webServer.register({ path: … })`, plus the indirect modules. */
function registered(): { direct: Set<string>; indirect: Set<string> } {
  const direct = new Set<string>()
  const indirect = new Set<string>()
  for (const file of serverSources()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/path:\s*(POOL_[A-Z0-9_]+)/gu)) direct.add(match[1]!)
    if (INDIRECT.test(text)) {
      // A module that registers through `paths.x` names its constants somewhere in the file.
      for (const match of text.matchAll(/(POOL_[A-Z0-9_]+_PATH)/gu)) indirect.add(match[1]!)
    }
  }
  return { direct, indirect }
}

/** Constants the browser half references. */
function clientRefs(): Set<string> {
  const refs = new Set<string>()
  const dir = new URL('client/', SRC)
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/(POOL_[A-Z0-9_]+_PATH)\b/gu)) refs.add(match[1]!)
  }
  return refs
}

describe('every route the browser calls is registered by the host', () => {
  it('has no client-only route', () => {
    const { direct, indirect } = registered()
    const missing = [...clientRefs()]
      .filter(name => !direct.has(name) && !indirect.has(name))
      .sort()
    expect(missing, `这些路由客户端会调，但宿主从未注册：${missing.join(', ')}`).toEqual([])
  })

  it('registers the per-channel usage routes', () => {
    const text = readFileSync(new URL('web-status.ts', SRC), 'utf8')
    /*
       Two halves in one handler: a read that the card polls on mount, and a
       write that must return the whole document so the pane can repaint without
       a second round trip. Asserting both keeps a future edit from keeping the
       GET and dropping the POST.
    */
    expect(text).toContain('POOL_CHANNEL_USAGE_PATH')
    expect(text).toMatch(/req\.method === 'GET'\) return json\(res, 200, deps\.channelUsage\(\)\)/u)
    expect(text).toContain('await deps.setChannelUsage(')
    // The answer after a write is the document, not `{ok:true}`.
    expect(text).toMatch(/await deps\.setChannelUsage\([^)]*\)\s*\n\s*json\(res, 200, deps\.channelUsage\(\)\)/u)
  })

  it('rejects a strategy it cannot store', () => {
    // An unknown strategy must not be persisted: it would be read back, fail
    // every comparison, and silently resolve to the pool default.
    const text = readFileSync(new URL('web-status.ts', SRC), 'utf8')
    expect(text).toContain('invalid channel')
    expect(text).toContain('invalid strategy')
    // The channel name is checked against a bare-identifier pattern, so a URL or
    // a path cannot be stored as a provider id.
    expect(text).toMatch(/\[A-Za-z0-9_-\]/u)
    /*
      A type check is not a value check. `setChannelUsage` validates again and
      silently drops an unknown value, so checking only `typeof raw === 'string'`
      answered `200` for `"nonsense"` with an unchanged document — a save and a
      no-op were indistinguishable to the caller. This asserts the membership
      test is actually applied.
    */
    expect(text).toContain('isDistributionStrategy(raw)')
  })

  it('reports the pool strategy the pool is actually running', () => {
    /*
      Found by exercising the live route: `channels/usage` answered
      `pool: {}` while `/status` answered `distribution: "expiry"`.
      The cause was reading `config.distribution` — the value `apply()` was
      handed at mount, which a host that never writes that key leaves at the
      schema default. `status` has always used `pool.currentDistribution()`;
      the two screens must agree, so the pane now reads the same call.
    */
    const text = readFileSync(new URL('index.ts', SRC), 'utf8')
    const at = text.indexOf('channelUsage: () => ({')
    expect(at, 'channelUsage dep is gone').toBeGreaterThan(-1)
    // Slice to the end of the dep's own object, not a fixed width: the comment
    // above the `pool` key is long, and a truncated window would assert against
    // the wrong thing.
    const end = text.indexOf('setChannelUsage:', at)
    expect(end, 'setChannelUsage dep is gone').toBeGreaterThan(at)
    const block = text.slice(at, end)
    expect(block).toContain('core.pool.currentDistribution()')
    /*
      Assert against the CODE, not the prose: the comment above `pool` explains
      the old bug by name, so a plain `not.toContain` would fail on the very
      documentation that prevents a regression. Both comment forms are stripped
      before the assertion.
    */
    const code = block
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/u, ''))
      .join('\n')
    expect(code, 'the mount-time config value is not the live strategy').not.toContain('config.distribution')
  })
})
