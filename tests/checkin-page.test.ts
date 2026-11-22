import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The claim ledger is a rail PAGE, not a dialog.
 *
 * WHY THIS IS PINNED
 *
 * It shipped first as a modal opened from a channel's automation panel. A modal
 * can only answer "what happened in the run I am looking at": it covers the pool
 * while open, and comparing runs and channels is the entire reason to read a
 * ledger. So it moved to the rail, where the other "read everything" pages live.
 *
 * Two things can regress silently and both are asserted here:
 *   1. The page falling out of the rail — it would still compile, still be
 *      reachable from the channel panel, and only the rail row would be missing.
 *   2. A dialog creeping back in — the old component is deleted, so a re-added
 *      `<style>` block or a `position: fixed` scrim would be the first sign.
 */

const SRC = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, SRC), 'utf8')

describe('the claim ledger is a rail page', () => {
  it('has a rail tab', () => {
    const shell = read('PoolCard.tsx')
    expect(shell).toMatch(/id: 'checkin', label: t\?\.\('shell\.tabCheckin'\)/u)
  })

  it('renders the page for that tab', () => {
    const shell = read('PoolCard.tsx')
    expect(shell).toContain("page === 'checkin' ? <AutoCheckinPage")
    // The channel panel opens it by switching the page, not by opening a modal.
    expect(shell).toContain("onOpenCheckin={() => { setPage('checkin') }}")
  })

  it('gives the page a rail icon and localized labels', () => {
    // A tab with no entry in RAIL_ICONS falls back to the bare initial, which
    // reads as a placeholder next to seven real glyphs.
    expect(read('rail-icons.ts')).toContain('checkin:')
    const locales = read('locales.ts')
    expect(locales).toContain("'shell.tabCheckin': 'Claim ledger'")
    expect(locales).toContain("'shell.tabCheckin': '领取账本'")
  })

  it('uses the shared page skeleton, not a dialog shell', () => {
    const page = read('AutoCheckinPage.tsx')
    expect(page).toContain('<main className="main">')
    expect(page).toContain('<header className="mhead">')
    expect(page).toContain('<div className="mbody">')
    /*
      A dialog would need its own scrim and would have to inject a stylesheet.
      `bundle-contract.test.ts` already fails on a component that injects one;
      this catches the other half — a full-viewport fixed overlay pretending to
      be a page.
    */
    expect(page).not.toMatch(/position:\s*'fixed'/u)
    expect(page).not.toContain('<style>')
  })

  it('deleted the dialog it replaced', () => {
    // `git rm` is not something a later refactor notices; a stale import of a
    // deleted module fails the build, but a leftover file would not.
    expect(() => read('AutoCheckinDetails.tsx')).toThrow()
  })
})
