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
 */
const pool = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')

describe('pool account cards mount inside the detail column', () => {
  it('PoolCard hands the cards to ChannelPoolSection as a prop, not as a grid child', () => {
    expect(pool).toContain('const poolAccounts = (')
    expect(pool).toContain('poolAccounts={poolAccounts}')
    // The wrapper that turned them into grid children must not come back.
    expect(pool).not.toContain("style={{ display: 'contents' }}")
  })

  it('ChannelPoolSection renders them at the top of .mbody in both branches', () => {
    const bodies = [...channels.matchAll(/<div className="mbody"[^>]*>\r?\n\s*\{poolAccounts\}\r?\n\s*\{banner\}/gu)]
    expect(bodies.length, 'the empty body and the chosen-entry body must both carry the cards above the banner').toBe(2)
  })

  it('keeps the host-compat anchor class names and adds the layout class', () => {
    expect(pool).toContain('className="dsm-xdpool-regions dsm-xdpool-region-grid xdp-acct-regions"')
  })
})
