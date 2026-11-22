import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The plugin borrows the host's PAGE background, not its surface colours.
 *
 * THE MISTAKE THIS LOCKS OUT
 *
 * "Make the background match dsh" was implemented as: bind every base variable
 * to the matching `--dsw-alias-*` token. On the host's light theme that turned
 * `--surface` into a near-white (`bg-layer-1`), while the plugin's text stayed
 * light — the model list rendered white-on-white and became unreadable.
 *
 * The distinction that matters:
 *
 *   --bg        the page behind the plugin → must follow the host, or the plugin
 *               is a differently-coloured rectangle pasted into the app;
 *   --surface*  the plugin's own cards → belong to this plugin's visual
 *               language, and only work as a coherent set with its text colours.
 *
 * Aliasing surfaces to the host also breaks the text tokens by the same logic:
 * host label colours go dark on a light theme, so pairing them with a dark card
 * inverts contrast. So: host for the page, design values for everything on it.
 */

const css = readFileSync(new URL('../src/client/design-css.ts', import.meta.url), 'utf8')

/** The `.app { ... }` block that declares the base variables. */
function baseVars(): string {
  const start = css.indexOf('.app {')
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('host theme integration', () => {
  it('follows the host for the page background', () => {
    expect(baseVars()).toContain('--bg: var(--dsw-alias-bg-layer-0')
  })

  it('does not alias surfaces to host bg layers', () => {
    /*
      Each of these would drag a light-theme near-white into a dark plugin. The
      assertion is per-variable rather than "no --dsw-alias anywhere" so the
      intent survives a future addition that is genuinely safe.
    */
    const vars = baseVars()
    for (const name of ['--surface', '--surface-2', '--surface-3']) {
      expect(vars, `${name} must keep the design value`).not.toMatch(
        new RegExp(`${name}:\\s*var\\(--dsw-alias-bg-layer`, 'u'),
      )
    }
  })

  it('does not alias text or divider colours to host tokens', () => {
    // Same failure mode, opposite direction: host labels darken on a light
    // theme, and pairing them with a dark card inverts contrast.
    const vars = baseVars()
    for (const name of ['--text', '--muted', '--faint', '--line', '--line-2', '--line-3']) {
      expect(vars, `${name} must keep the design value`).not.toMatch(
        new RegExp(`${name}:\\s*var\\(--dsw-alias-`, 'u'),
      )
    }
  })
})
