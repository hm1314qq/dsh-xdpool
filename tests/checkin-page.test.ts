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

describe('the claim ledger opens from the account pool header', () => {
  it('puts its entry in the pool list header, beside the three stats', () => {
    /*
      The entry belongs on the row that already says「账号池 · 13 账号 · 12 已连 ·
      2.6 万积分」: the ledger answers the fourth question that row implies —
      where those credits came from. A rail tab was tried first and rejected:
      the rail is the plugin's page switcher, and this is a reading of the pool,
      not a second place to stand.
    */
    const section = read('ChannelPoolSection.tsx')
    const head = section.slice(section.indexOf('className="list-stats"'))
    const beforeScroll = head.slice(0, head.indexOf('list-scroll'))
    expect(beforeScroll, 'the entry must sit inside .list-head').toContain('onOpenCheckin')
    expect(beforeScroll).toContain("t?.('chan.autoDetails')")
  })

  it('keeps it out of the rail', () => {
    // Three task lists ago this was a rail page. Two entries for one page is
    // how a plugin ends up with a nav that nobody can reason about.
    const shell = read('PoolCard.tsx')
    expect(shell).not.toContain("id: 'checkin'")
  })

  it('renders the page when the pool asks for it', () => {
    const shell = read('PoolCard.tsx')
    expect(shell).toContain("page === 'checkin' ? <AutoCheckinPage")
    // The pool header opens it by switching the page, not by opening a modal.
    expect(shell).toContain("onOpenCheckin={() => { setPage('checkin') }}")
  })

  it('keeps a rail icon available even though the rail no longer shows it', () => {
    // RAIL_ICONS is keyed by page id; leaving the glyph in place means restoring
    // the tab later is a one-line change, and a missing key would silently fall
    // back to the bare initial.
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
