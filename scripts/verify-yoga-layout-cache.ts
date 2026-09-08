/**
 * verify-yoga-layout-cache — Yoga 逐节点布局缓存的槽位预算回归。
 *
 * 一次 flexbox 过程会用多组不同入参反复探测同一个节点（measure 遍 + layout
 * 遍 + min/max 校验），槽位按轮转淘汰。预算低于该工作集时，循环探测顺序把
 * 命中率压到 ~0，每帧全量重测；这与 line-width-cache / wrap-text 的溢出清空
 * 是同一类缺陷。此处断言：预算不低于实测探测集、跨代保留可复用条目、且缓存
 * 命中的几何与整树重算完全一致（缓存只省时间，不改结果）。
 *
 * 负反控（必须真的会失败）：把预算调回 4 后重跑同一断言。
 *
 * 运行：node --import tsx/esm scripts/verify-yoga-layout-cache.ts
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { default: instances },
  dom,
  yoga,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/dom.js'),
  import('../src/native-ts/yoga-layout/index.js'),
])

const {
  Node: YogaNode,
  layoutCacheSlotsForTest,
  setLayoutCacheSlotsForTest,
  setLayoutCacheLayoutPassHitsForTest,
} = yoga

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 实测：steady 负载下最热节点单帧被 11 组不同入参探测（见 rendering.md）。
const PROBED_TUPLES = 11
// 单帧 measure 调用上限。修复后实测约 11，修复前约 1425。
const MEASURE_BUDGET_PER_FRAME = 200

// ── 预算尺寸 ──
{
  const { slots, capacity } = layoutCacheSlotsForTest()
  check('budget equals allocated capacity', slots === capacity, `${slots}/${capacity}`)
  check(
    'budget covers the measured probe working set',
    slots >= PROBED_TUPLES,
    `${slots} slots vs ${PROBED_TUPLES} tuples`,
  )
}

// ── 跨代保留：11 个宽度轮转后，最早的宽度仍应命中 ──
// root → box → text(measureFunc)：容器的 flex-basis 探测走 measure 遍，
// 也就是多槽缓存实际服务的那条路径。
type Probe = {
  root: InstanceType<typeof YogaNode>
  leaf: InstanceType<typeof YogaNode>
  calls: () => number
}
function makeProbe(): Probe {
  const root = new YogaNode()
  const box = new YogaNode()
  const leaf = new YogaNode()
  let calls = 0
  leaf.setMeasureFunc((w: number) => {
    calls += 1
    return { width: Number.isNaN(w) ? 10 : Math.min(w, 40), height: 3 }
  })
  box.insertChild(leaf, 0)
  root.insertChild(box, 0)
  return { root, leaf, calls: () => calls }
}

// 该探针每个宽度产生 4 组入参，故 3 个宽度 = 12 组：越过 4 槽预算、仍在
// 16 槽内。
const WIDTHS = [60, 61, 62]

function extraCallsOnOldestWidth(): number {
  const p = makeProbe()
  for (const w of WIDTHS) p.root.calculateLayout(w, undefined)
  const before = p.calls()
  p.root.calculateLayout(WIDTHS[0]!, undefined)
  return p.calls() - before
}

{
  const full = extraCallsOnOldestWidth()
  setLayoutCacheSlotsForTest(4)
  const starved = extraCallsOnOldestWidth()
  setLayoutCacheSlotsForTest(layoutCacheSlotsForTest().capacity)
  check(
    'earlier probe tuples survive the round-robin wrap',
    full < starved,
    `${full} extra measure calls at 16 slots vs ${starved} at 4`,
  )
  check(
    'NEGATIVE CONTROL C: budget 4 re-measures the oldest width',
    starved > 0,
    `${starved} extra measure calls at 4 slots`,
  )
}

// ── 命中值必须等于冷算值 ──
{
  const warm = makeProbe()
  for (const w of WIDTHS) warm.root.calculateLayout(w, undefined)
  warm.root.calculateLayout(WIDTHS[0]!, undefined)
  const cold = makeProbe()
  cold.root.calculateLayout(WIDTHS[0]!, undefined)
  check(
    'cache hit returns the cold-computed geometry',
    warm.leaf.getComputedWidth() === cold.leaf.getComputedWidth() &&
      warm.leaf.getComputedHeight() === cold.leaf.getComputedHeight(),
    `${warm.leaf.getComputedWidth()}x${warm.leaf.getComputedHeight()} vs ${cold.leaf.getComputedWidth()}x${cold.leaf.getComputedHeight()}`,
  )
}

// ── 失效仍然生效：内容变更 + markDirty 后必须重测 ──
function mutatingProbe(): { node: InstanceType<typeof YogaNode>; setHeight: (h: number) => void } {
  const node = new YogaNode()
  let h = 3
  node.setMeasureFunc(() => ({ width: 20, height: h }))
  return { node, setHeight: (next: number) => { h = next } }
}
{
  const p = mutatingProbe()
  p.node.calculateLayout(80, undefined)
  const first = p.node.getComputedHeight()
  p.setHeight(9)
  // 负反控 A：不调 markDirty —— 断言必须看到陈旧值，否则下面那条
  // 「markDirty 后重测」的断言就不依赖失效逻辑，等于没测。
  p.node.calculateLayout(80, undefined)
  const stale = p.node.getComputedHeight()
  check('NEGATIVE CONTROL A: without markDirty the cached height persists',
    stale === first, `${first} -> ${stale}`)
  p.node.markDirty()
  p.node.calculateLayout(80, undefined)
  check('markDirty forces a re-measure', p.node.getComputedHeight() === 9,
    `${stale} -> ${p.node.getComputedHeight()}`)
}

// ── 真实 Chat 树：每帧 measure 预算 + 几何与整树重算一致 ──
const BASE_COLS = 108
const ROWS = 34
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeTerminal() {
  const term = new XTerm({ cols: BASE_COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  let lastFlushed: Promise<void> = Promise.resolve()
  class FakeStdout extends Writable {
    columns = BASE_COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      lastFlushed = new Promise<void>(res => term.write(String(chunk), () => { cb(); res() }))
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  return {
    term,
    stdout: new FakeStdout() as never,
    stderr: new FakeStderr() as never,
    stdin: new FakeStdin() as never,
    flush: () => lastFlushed,
  }
}

function makeRows(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let id = 0
  for (let t = 0; t < 40; t++) {
    out.push({ id: id++, kind: 'user', text: '问题 ' + t + '：分析模块 ' + t + ' 的边界条件与失败模式' })
    out.push({ id: id++, kind: 'assistant', text: '回答 ' + t + '：\n\n- 条件成立\n- 边界已覆盖\n- 结论稳定', streaming: false })
  }
  return out
}

type Geometry = string
function snapshotGeometry(node: unknown): Geometry {
  const parts: string[] = []
  const walk = (n: { children: unknown[]; layout: { left: number; top: number; width: number; height: number } }): void => {
    const l = n.layout
    parts.push(`${l.left},${l.top},${l.width},${l.height}`)
    for (const c of n.children) walk(c as never)
  }
  walk(node as never)
  return parts.join(';')
}

type Run = { perFrameMeasured: number; frames: number; staleFrames: number }

async function runSteady(label: string): Promise<Run> {
  const rows = makeRows()
  const streamRow: Record<string, unknown> = { id: 9999, kind: 'assistant', text: '', streaming: true }
  rows.push(streamRow)
  const listeners = new Set<() => void>()
  const channel: Record<string, unknown> = {
    version: 0, rows, status: 'idle', sessionTitle: 'cache-regression', agentId: 'x',
    model: 'deepseek-v4-flash', reasoningEffort: 'max',
    tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
    gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: String(rows[0]!['text']),
    pending: [], commandList: [], notifications: [],
    mode: { plan: false }, effortLevels: undefined,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => [],
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
  }
  const t = makeTerminal()
  await render(
    React.createElement(
      AlternateScreen as never,
      null,
      React.createElement(Chat as never, { channel: channel as never, questionStore: new QuestionStore() as never }),
    ),
    { stdout: t.stdout, stdin: t.stdin, stderr: t.stderr, exitOnCtrlC: false, patchConsole: false },
  )
  const ink = instances.get(t.stdout) as unknown as {
    rootNode: { yogaNode: { yoga: unknown; calculateLayout: (w: number) => void }; onComputeLayout: () => void }
    setAltScreenActive: (a: boolean, b: boolean) => void
    lastYogaCounters?: { measured: number; live: number }
    unmount: () => void
  }
  if (!ink) throw new Error('Ink instance not found')
  ink.setAltScreenActive(true, true)
  // 固定窗:pacing 切 alt-screen 后等场景稳定到 steady 再插桩，无单一可轮询锚点。
  await sleep(1200)
  await t.flush()

  const origCompute = ink.rootNode.onComputeLayout
  let measured = 0
  let liveNodes = 0
  let frames = 0
  let staleFrames = 0
  ink.rootNode.onComputeLayout = () => {
    origCompute()
    measured += ink.lastYogaCounters?.measured ?? 0
    liveNodes = ink.lastYogaCounters?.live ?? liveNodes
    frames += 1
    // 陈旧检测：把整树标脏后重算，几何必须与缓存结果逐字节相同。
    const cached = snapshotGeometry((ink.rootNode.yogaNode as { yoga: unknown }).yoga)
    dom.markTreeDirty(ink.rootNode as never)
    ink.rootNode.yogaNode.calculateLayout(BASE_COLS)
    const fresh = snapshotGeometry((ink.rootNode.yogaNode as { yoga: unknown }).yoga)
    if (fresh !== cached) {
      staleFrames += 1
      const a = cached.split(';')
      const b = fresh.split(';')
      const i = a.findIndex((v, k) => v !== b[k])
      console.log(`  [${label}] DIVERGE frame#${frames} nodes=${a.length}/${b.length} at ${i}: cached=${a[i]} fresh=${b[i]}`)
    }
  }

  for (let i = 0; i < 12; i++) {
    streamRow['text'] = String(streamRow['text']) + '流式追加的内容片段，模拟正常输出。'
    ;(channel['version'] as number)
    channel['version'] = (channel['version'] as number) + 1
    for (const cb of listeners) cb()
    // 固定窗:pacing 流式追加步间的节奏等待——每步只推进 channel version，无可观测完成条件。
    await sleep(8)
    await t.flush()
  }
  ink.rootNode.onComputeLayout = origCompute
  ink.unmount()
  // 固定窗:pacing unmount 后等末帧 flush 完再结算计数器，无可观测完成条件。
  await sleep(120)
  const perFrameMeasured = frames === 0 ? Number.POSITIVE_INFINITY : measured / frames
  console.log(`  [${label}] frames=${frames} measured/frame=${perFrameMeasured.toFixed(1)} staleFrames=${staleFrames} liveNodes=${liveNodes}`)
  return { perFrameMeasured, frames, staleFrames }
}

const full = await runSteady('budget=16')
check('steady frames were sampled', full.frames > 0, `${full.frames} frames`)
check(
  'per-frame measure calls stay within budget',
  full.perFrameMeasured <= MEASURE_BUDGET_PER_FRAME,
  `${full.perFrameMeasured.toFixed(1)} <= ${MEASURE_BUDGET_PER_FRAME}`,
)
check('no frame diverged from a full recompute', full.staleFrames === 0, `${full.staleFrames} stale frames`)

// ── 负反控 B：预算回到 4，同一条 measure 预算断言必须失败 ──
setLayoutCacheSlotsForTest(4)
const starved = await runSteady('budget=4')
check(
  'NEGATIVE CONTROL B: budget 4 blows the per-frame measure budget',
  starved.perFrameMeasured > MEASURE_BUDGET_PER_FRAME,
  `${starved.perFrameMeasured.toFixed(1)} > ${MEASURE_BUDGET_PER_FRAME}`,
)
check(
  'NEGATIVE CONTROL B: the undersized budget is slow, not stale',
  starved.staleFrames === 0,
  `${starved.staleFrames} stale frames`,
)
setLayoutCacheSlotsForTest(layoutCacheSlotsForTest().capacity)
check(
  'budget restored after the negative control',
  layoutCacheSlotsForTest().slots === layoutCacheSlotsForTest().capacity,
)
console.log(
  `  ratio: budget=4 measures ${(starved.perFrameMeasured / full.perFrameMeasured).toFixed(1)}x per frame`,
)

// ── 负反控 D：放回 layout 遍的多槽命中，陈旧断言必须失败 ──
// 一个容器命中「非最后布局态」的入参组就跳过子节点递归，被跳过的子树留在
// measure 探测的临时几何上。
setLayoutCacheLayoutPassHitsForTest(true)
const unguarded = await runSteady('layout-pass hits re-admitted')
setLayoutCacheLayoutPassHitsForTest(false)
check(
  'NEGATIVE CONTROL D: layout-pass cache hits leave stale geometry',
  unguarded.staleFrames > 0,
  `${unguarded.staleFrames} stale frames with the guard removed`,
)
const restored = await runSteady('guard restored')
check('guard restored: no stale frames', restored.staleFrames === 0, `${restored.staleFrames} stale frames`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
