/**
 * The claim ledger's own rules — the few the 3.0 dialog vocabulary lacks.
 *
 * PROVENANCE, AND WHY THIS IS ITS OWN MODULE
 *
 * These rules used to live at the tail of `styles.ts` as `AUTO_LEDGER_CSS`. The
 * intent was always "join the one injected sheet" (see `design-style.ts`), and
 * importing them from there worked — but it dragged the whole 2.x legacy module
 * into the client bundle: rolldown kept ~150 KB of dead rules from the other
 * eleven exports alongside the ~4 KB actually referenced, and `client.js`
 * jumped from 1.15 MB to 1.31 MB. So the sheet moved here, to a module with
 * exactly one export and nothing else in the graph.
 *
 * WHAT BELONGS HERE
 *
 * The dialog skeleton (scrim → `.pick` → `.pick-head` → `.pick-tools` →
 * `.pick-list`) is all 3.0 vocabulary and lives in `design-css.ts`. Only what
 * 3.0 genuinely lacks goes here: the run picker's typography, the group tones,
 * the dotted leader between an account and its amount, and the upstream failure
 * line. Every colour and spacing value comes from the design tokens — no local
 * variables, no second set to keep in sync.
 *
 * WIRED WHERE
 *
 * `design-style.ts` concatenates this into `FULL_CSS`, so it is injected once
 * with everything else and hot reloads replace it in place. `tests/
 * checkin-page.test.ts` pins both halves of that contract.
 *
 * @module dsh-xdpool/client/ledger-styles
 */
export const AUTO_LEDGER_CSS = `
/* ---- 领取详情弹窗（AutoCheckinDetails）----

   弹窗骨架（遮罩 + .pick + .pick-head + .pick-tools + .pick-list）全部复用 3.0
   已有的类，这里补的只有 3.0 没有的四样：
   轮次选择器的排版、分组的色调、账号与金额之间的虚线引导、上游错误原文的次要行。
   一切颜色与间距都取设计稿令牌，不引入自己的变量。 */

/* 轮次选择器：跟在 .pick-tools 的一行里，标签淡、下拉框贴合令牌 */
.ledger-pick{display:flex;align-items:center;gap:var(--s2);font-size:var(--fs-xs);color:var(--faint)}
.ledger-pick select{
  padding:2px 6px;
  border-radius:var(--r-sm);
  border:1px solid var(--line-2);
  background:var(--surface-2);
  color:var(--text);
  font-size:var(--fs-xs);
  font-family:inherit;
}
.ledger-pick select:disabled{opacity:.5}

/* 分组：容器不管间距（.pick-list 已经给了），只管标题那一行的排版 */
.ledger-group{display:flex;flex-direction:column;gap:2px;margin-top:var(--s3)}
.ledger-group:first-child{margin-top:0}
.ledger-grouphead{
  display:flex;align-items:center;gap:var(--s2);
  margin:0 0 var(--s1);
  padding:0 var(--s2);
  font-weight:400;
}
.ledger-dot{
  flex:0 0 auto;width:6px;height:6px;border-radius:var(--r-pill);
  background:var(--faint);
}
.ledger-group[data-tone="success"] .ledger-dot{background:var(--ok)}
.ledger-group[data-tone="already"] .ledger-dot{background:var(--accent)}
.ledger-group[data-tone="failed"] .ledger-dot{background:var(--danger)}
.ledger-group[data-tone="other"] .ledger-dot{background:var(--faint)}
.ledger-grouplabel{font-size:var(--fs-xs);color:var(--muted);white-space:nowrap}
.ledger-rule{flex:1 1 auto;height:1px;background:var(--line)}
.ledger-count{
  flex:0 0 auto;
  font-size:var(--fs-xs);color:var(--faint);
  font-family:var(--mono);font-variant-numeric:tabular-nums;
}

.ledger-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.ledger-line{display:flex;flex-direction:column;gap:1px;padding:0 var(--s2)}

/* 一行账目：名字 —— 虚线引导 —— 金额。引导线是这张「小票」的全部视觉主张 */
.ledger-row{display:flex;align-items:baseline;gap:var(--s2);min-width:0}
.ledger-who{
  flex:0 1 auto;min-width:0;
  font-size:var(--fs-sm);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ledger-leader{
  flex:1 1 auto;min-width:12px;
  align-self:center;
  height:1px;
  background-image:linear-gradient(to right,var(--line-2) 0 2px,transparent 2px 5px);
  background-size:5px 1px;
  background-repeat:repeat-x;
}
.ledger-amount{
  flex:0 0 auto;
  font-size:var(--fs-sm);
  font-family:var(--mono);
  font-variant-numeric:tabular-nums;
}
.ledger-amount[data-tone="success"]{color:var(--ok)}
.ledger-amount[data-tone="already"]{color:var(--muted)}
.ledger-amount[data-tone="failed"]{color:var(--danger)}
.ledger-namount{
  flex:0 0 auto;
  font-size:var(--fs-xs);color:var(--faint);
  white-space:nowrap;
}

/* 失败原因：上游原文照录，不和上面的数字抢注意力 */
.ledger-why{
  font-size:var(--fs-xs);
  color:var(--faint);
  line-height:1.5;
  overflow-wrap:anywhere;
}
.ledger-code{font-family:var(--mono);opacity:.8}

/* ---- 长列表里的可读性：分组标题吸附在滚动容器顶部，翻账本时始终看得到自己
   在哪个分组；行悬停把当前行的名字提亮，长列表里对准行 ---- */
.ledger-grouphead{position:sticky;top:0;z-index:1;background:var(--surface-2)}
.ledger-line:hover .ledger-who{color:var(--text)}
`
