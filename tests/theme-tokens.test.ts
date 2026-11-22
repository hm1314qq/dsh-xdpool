import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The whole palette follows the host, so the plugin is not "the dark one".
 *
 * THE TWO MISTAKES THIS LOCKS OUT
 *
 * 1. A fixed palette (the original state). The design is dark, so the plugin
 *    stayed dark no matter what the host did — with a white host theme it read
 *    as a black rectangle pasted into a light app.
 * 2. Aliasing only `--bg` to the host and keeping surfaces on the design values.
 *    That is worse, not better: a light page behind dark cards, two visual
 *    languages at once.
 *
 * The rule that actually works: surfaces and text must move TOGETHER. Either
 * both follow the host (light theme → light cards + dark text, contrast
 * preserved) or neither does. Half-following is what produces unreadable
 * combinations.
 *
 * `--accent` and the status colours stay on the design values on purpose: the
 * green is this plugin's identity, not the host's brand.
 */

const css = readFileSync(new URL('../src/client/design-css.ts', import.meta.url), 'utf8')

/** The `.app { ... }` block that declares the base variables. */
function baseVars(): string {
  const start = css.indexOf('.app {')
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

/** Variables that must be driven by the host, with the token suffix to check. */
const HOST_BOUND: readonly (readonly [string, string])[] = [
  ['--bg', '--dsw-alias-bg-layer-0'],
  ['--surface', '--dsw-alias-bg-layer-1'],
  ['--surface-2', '--dsw-alias-bg-layer-2'],
  ['--surface-3', '--dsw-alias-bg-layer-3'],
  ['--text', '--dsw-alias-label-primary'],
  ['--muted', '--dsw-alias-label-secondary'],
  ['--faint', '--dsw-alias-label-tertiary'],
  ['--line', '--dsw-alias-border-l1'],
  ['--line-2', '--dsw-alias-border-l2'],
  ['--line-3', '--dsw-alias-border-l3'],
]

describe('the palette follows the host theme', () => {
  for (const [name, token] of HOST_BOUND) {
    it(`${name} reads ${token}`, () => {
      expect(baseVars(), `${name} must derive from ${token}`).toMatch(
        new RegExp(`${name}:\\s*var\\(${token}`, 'u'),
      )
    })
  }

  it('keeps a design fallback for a host that supplies no tokens', () => {
    // Standalone preview and a host without aliases both land here; the design
    // value is what makes the plugin look like itself in that case.
    expect(baseVars()).toMatch(/--bg:\s*var\(--dsw-alias-bg-layer-0,\s*oklch\(/u)
  })

  it('keeps the accent on the design palette', () => {
    // The green is the plugin's identity. Host brand colour would repaint every
    // button and switch, which is how an earlier version lost the design.
    const vars = baseVars()
    expect(vars).not.toMatch(/--accent:\s*var\(--dsw-alias-brand/u)
    expect(vars).toMatch(/--accent:\s*oklch\(/u)
  })

  it('has no theme-dependent white literals left', () => {
    /*
      `oklch(100% 0 0 / .06)` is "lift by 6%" — invisible on a light surface.
      Borders and hairlines must go through --line* (host-bound), and any other
      lightening goes through `currentColor` or `var(--text)`, both of which
      invert with the theme. Hex-with-alpha whites (`#ffffff1f`) are the same
      hazard.
    */
    const sources = ['design-css.ts', 'styles.ts', 'pool-shell-styles.ts']
    const offenders: string[] = []
    for (const name of sources) {
      const text = readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
      // Comments are excluded: they document the hazard by quoting it.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .split('\n')
        .map(line => line.replace(/\/\/.*$/u, ''))
        .join('\n')
      for (const match of code.matchAll(/oklch\(\s*100%\s+0\s+0\s*\/\s*0?\.[0-9]+\s*\)/gu)) {
        // The declared fallbacks inside var() are fine: they only apply when the
        // host supplies no token at all, and then the whole palette is the dark one.
        const before = code.slice(Math.max(0, match.index - 60), match.index)
        if (/var\(#[^)]*$/u.test(before) || /--line(-2|-3)?:\s*var\(/u.test(before)) continue
        if (code.slice(code.lastIndexOf('\n', match.index), match.index).includes('--line')) continue
        offenders.push(`${name}: ${match[0]}`)
      }
      for (const match of code.matchAll(/#(?:ffffff|fff)[0-9a-fA-F]{2}\b/gu)) {
        // A pure white used as a MIX TARGET (colour math on a brand hue) is not
        // theme-dependent and is left alone.
        const before = code.slice(Math.max(0, match.index - 80), match.index)
        if (/color-mix\([^)]*$/u.test(before)) continue
        offenders.push(`${name}: ${match[0]}`)
      }
    }
    expect(offenders, `这些写死的浅色在浅色主题下会消失：\n${offenders.join('\n')}`).toEqual([])
  })
})
