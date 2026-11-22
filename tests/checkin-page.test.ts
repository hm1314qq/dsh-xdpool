import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The claim ledger opens as a DIALOG from the account pool header.
 *
 * WHY THIS IS PINNED
 *
 * It has been through three shapes, and each move was a correction, so the
 * current one is worth writing down:
 *
 *   1. a modal opened from a channel's automation panel — too far from the
 *      numbers it explains;
 *   2. a rail page — right idea about "see everything", wrong place: the rail is
 *      the page switcher, and reading a ledger is not changing where you stand;
 *   3. a dialog opened from the pool's own header row, beside
 *      「13 账号总数 · 12 已连 · 2.6 万积分」 — the ledger answers the fourth
 *      question that row implies, and closing it returns you to where you were.
 *
 * Three things can regress silently:
 *   - the entry drifting out of the header row;
 *   - the dialog turning back into a page jump (losing the pool context);
 *   - a component re-injecting its own stylesheet, which `bundle-contract`
 *     forbids and which was the original reason the sheet moved into `styles.ts`.
 */

const SRC = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, SRC), 'utf8')

describe('the claim ledger is a dialog opened from the pool header', () => {
  it('puts its entry in the pool list header, beside the three stats', () => {
    /*
      `list-head` holds the title row and the stats row; the entry belongs after
      the stats and before `list-scroll`, so it sits on the header rather than
      scrolling away with the channel list.
    */
    const section = read('ChannelPoolSection.tsx')
    const head = section.slice(section.indexOf('className="list-stats"'))
    const beforeScroll = head.slice(0, head.indexOf('list-scroll'))
    expect(beforeScroll, 'the entry must sit inside .list-head').toContain('openAutoDetails')
    expect(beforeScroll).toContain("t?.('chan.autoDetails')")
  })

  it('opens a dialog rather than switching pages', () => {
    const section = read('ChannelPoolSection.tsx')
    // The handler sets local state; a `setPage` call here would leave the pool.
    expect(section).toContain('setAutoDetailsOpen(true)')
    expect(section).toContain('<AutoCheckinDetailsDialog')
    // Mounted at the end of the page, outside `main`, so the detail column's
    // scroll container cannot clip it.
    const tail = section.slice(section.lastIndexOf('</main>'))
    expect(tail).toContain('<AutoCheckinDetailsDialog')
  })

  it('keeps no page-shaped leftover', () => {
    // The rail page and its `checkin` branch are gone; a half-removed page
    // would still compile and leave a dead branch behind.
    const shell = read('PoolCard.tsx')
    expect(shell).not.toContain('AutoCheckinPage')
    expect(shell).not.toContain("page === 'checkin'")
    expect(() => read('AutoCheckinPage.tsx')).toThrow()
  })

  it('uses the shared 3.0 dialog vocabulary and injects no stylesheet', () => {
    const dialog = read('AutoCheckinDetails.tsx')
    // Same skeleton as the aggregate page's model picker.
    expect(dialog).toContain('className="pick"')
    expect(dialog).toContain('pick-head')
    expect(dialog).toContain('pick-list')
    // `bundle-contract.test.ts` fails a component that injects its own <style>;
    // this catches the intent as well as the mechanism. Matched as an ELEMENT
    // (`<style>{…}</style>`), not as the words: the header explains the history
    // and mentions the tag by name.
    expect(dialog).not.toMatch(/<style>\s*\{/u)
  })

  it('ships its few extra rules from the shared sheet', () => {
    // Only what 3.0 genuinely lacks: the run picker, group tones, the dotted
    // leader, and the failure line.
    const styles = read('styles.ts')
    expect(styles).toContain('.ledger-grouplabel')
    expect(styles).toContain('.ledger-leader')
    expect(styles).toContain('export const AUTO_LEDGER_CSS')
  })
})
