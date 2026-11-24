import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 插件池账号卡必须渲染在详情列里，不能是 .app 网格的直接子元素。
 *
 * 3.0.4 把两张账号卡 section 用 `display: contents` 的包装挂在 PoolShell 的 children 里。
 * .app 是三列 grid，children 里每个元素各占一格 —— `display: contents` 只是不占盒子，
 * 格子照占：渠道列表被挤到 rail 底下的 64px 窄带，详情列剩 232px，两张卡互相叠住。
 * 用户看到的原话是「UI 全部都乱套了」。
 *
 * 和 banner 同一条路：这类块只能作为 prop 交给 ChannelPoolSection，落在 .mbody 顶部。
 *
 * 3.0.7 重做了这件事，prop 名从本地分支的 `poolAccounts` 改成 `regionCards`，
 * 并且加了「只在 WorkBuddy 区域显示」的条件。断言跟着改名，守的东西不变：
 * 卡片是 prop 进来的、不是 .app 的子项。
 */
const pool = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')

describe('pool account cards mount inside the detail column', () => {
  it('PoolCard hands the cards to ChannelPoolSection as a prop, not as a grid child', () => {
    expect(pool).toContain('regionCards={')
    /*
      The `display: contents` anchor still exists — upstream uses it to mark "this
      page is the pool" for the layout tests — but it must wrap ONLY
      `<ChannelPoolSection>`, never the account sections. Cards nested inside it
      become `.app` grid children again, which is the 3.0.4 breakage: the channel
      list gets pushed under the rail and the detail column shrinks to 232px.

      So the check is what sits between the anchor and the component.
    */
    const anchor = pool.indexOf('dsm-xdpool-regions')
    expect(anchor, 'the layout anchor must still exist').toBeGreaterThan(-1)
    const between = pool
      .slice(anchor, pool.indexOf('<ChannelPoolSection', anchor))
      // The comment above the component explains the old bug BY NAME, so the
      // assertion has to read code, not prose.
      .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    expect(between, 'no card may be mounted as a sibling of ChannelPoolSection here')
      .not.toMatch(/<AccountBlock|<section/u)
  })

  it('ChannelPoolSection declares the prop and renders it in every branch', () => {
    expect(channels).toContain('regionCards')
    /*
      Two separate returns render a `.mbody`: the "no channel chosen" branch and
      the chosen-entry branch. Both must carry the cards, or the account list
      disappears whenever no card has been clicked yet.

      Counting occurrences is enough and is robust against the nesting; parsing
      the JSX tree with a regex is what broke the earlier revision of this test.
    */
    const renders = [...channels.matchAll(/\{regionCards\}/gu)]
    expect(renders.length, 'both .mbody returns must render the cards').toBe(2)
  })

  it('keeps the host-compat anchor class names', () => {
    // 锚点类名是别的测试和宿主兼容层在用的，改名会静默打断它们。
    expect(pool).toContain('dsm-xdpool-regions')
  })
})
