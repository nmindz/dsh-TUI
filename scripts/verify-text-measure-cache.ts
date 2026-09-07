/**
 * verify-text-measure-cache — 文本测量缓存的保留行为回归。
 *
 * 长会话的布局每帧按同一顺序重测所有挂载文本节点（循环访问）。缓存一旦
 * 在溢出时整表清空，命中率就会塌到 0，每帧重测整棵树。此处断言：超过旧
 * 预算的工作集仍能进入稳定态（第二遍零插入），溢出时按最旧淘汰而非清空。
 *
 * 运行：node --import tsx/esm scripts/verify-text-measure-cache.ts
 */
import { BoundedTextCache } from '../src/ink/bounded-text-cache.js'
import {
  lineWidth,
  lineWidthCacheStatsForTest,
  resetLineWidthCacheForTest,
} from '../src/ink/line-width-cache.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import wrapText from '../src/ink/wrap-text.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── BoundedTextCache: 预算记账与最旧淘汰 ──
{
  const c = new BoundedTextCache<number>(3, 1_000)
  c.set('a', 1)
  c.set('b', 2)
  c.set('c', 3)
  check('holds entries within budget', c.size === 3 && c.chars === 3)
  c.set('d', 4)
  check('evicts oldest past entry budget', c.size === 3 && c.get('a') === undefined)
  check('keeps newest past entry budget', c.get('d') === 4 && c.get('b') === 2)
}
{
  const c = new BoundedTextCache<number>(1_000, 10)
  c.set('x'.repeat(6), 1)
  c.set('y'.repeat(6), 2)
  check('char budget evicts oldest, not all', c.size === 1 && c.chars === 6)
  check('char budget keeps newest', c.get('y'.repeat(6)) === 2)
}
{
  const c = new BoundedTextCache<number>(1_000, 1_000)
  c.set('k', 1)
  c.set('k', 2)
  check('update in place does not double-bill', c.size === 1 && c.chars === 1 && c.get('k') === 2)
}
{
  // 单条超预算的行不得把表清空到 0（否则又回到整表清空的塌陷行为）
  const c = new BoundedTextCache<number>(1_000, 10)
  c.set('a', 1)
  c.set('z'.repeat(500), 2)
  check('oversized single entry leaves cache usable', c.size >= 1)
}

// ── lineWidth: 超过旧 100KB 预算的工作集仍进入稳定态 ──
{
  // 旧预算 100_000 字符 / 4096 条、且 >500 字符从不缓存——两条都要越过
  const lines: string[] = []
  for (let i = 0; i < 6_000; i++) lines.push(`row ${i} ${'x'.repeat(30)}`)
  for (let i = 0; i < 60; i++) lines.push(`long ${i} ${'y'.repeat(1_200)}`)
  const totalChars = lines.reduce((a, b) => a + b.length, 0)
  check('fixture exceeds the former budget', totalChars > 100_000, `${totalChars} chars`)

  resetLineWidthCacheForTest()
  for (const l of lines) lineWidth(l)
  const cold = lineWidthCacheStatsForTest()
  for (const l of lines) lineWidth(l)
  const warm = lineWidthCacheStatsForTest()
  // 命中率必须真的到 0 未命中：只比缓存条数会被「淘汰后重新插入」骗过，
  // 条数恒定而每遍仍在全量重测。
  check('second pass measures nothing (zero misses)', warm.misses === cold.misses,
    `${cold.misses} -> ${warm.misses} misses over ${lines.length} lines`)
  check('retains the whole working set', warm.size >= 6_000, `${warm.size} entries`)

  const long = lines[lines.length - 1]!
  check('settled long lines are cached', long.length > 500 && lineWidth(long) === stringWidth(long))
}

// ── 缓存值必须等于未缓存测量（宽字符/emoji/ANSI/零宽） ──
{
  const samples = [
    'plain ascii',
    '中文宽字符测试',
    'emoji 👨‍👩‍👧‍👦 family',
    '\u001b[31mred\u001b[39m',
    'combining e\u0301 mark',
    '',
  ]
  resetLineWidthCacheForTest()
  let allEqual = true
  for (const s of samples) {
    const cached = lineWidth(s)
    if (cached !== stringWidth(s) || lineWidth(s) !== cached) allEqual = false
  }
  check('cached width equals direct measurement', allEqual)
}

// ── wrapText: 同输入重复调用结果稳定（缓存不改变输出） ──
{
  const text = `${'word '.repeat(80)}\n${'另一段中文内容 '.repeat(20)}`
  const a = wrapText(text, 40, 'wrap')
  const b = wrapText(text, 40, 'wrap')
  check('wrap cache returns identical output', a === b && a.includes('\n'))
  const narrow = wrapText(text, 20, 'wrap')
  check('wrap cache keys on width', narrow !== a)
  const truncated = wrapText(text, 40, 'truncate')
  check('wrap cache keys on wrapType', truncated !== a)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
