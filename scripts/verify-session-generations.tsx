/**
 * verify-session-generations — 会话产物"世代"解析与继承切点回归。
 *
 * 上游 0.1.5 线把会话产物改成带世代的 `session.vN.jsonl.zstd`,并从物理头
 * 退休了 `seedLength`。本回归锁定 adapter 对这两件事的吸收:
 *
 *  [定位层] 世代名解析(逐字镜像上游 CANONICAL_LOG_FILENAME)、最高可读
 *           世代优先(同目录内两代共存时不能读到旧的)、非规范名一律不选、
 *           旧的无世代名仍可读、多 root 顺序、任意编码。
 *  [切点层] 从日志自身带 `inherited: true` 的 `session/end-seed` 边界推导
 *           继承前缀长度(切点 = 该事件的 seq),裸 end-seed 不算信号,
 *           探测预算耗尽时报 undefined 而不是猜。
 *  [后端层] `locate()` 只报当前世代时,在后端自己的目录内纠正世代名;
 *           指向别的目录则不得被同 id 副本悄悄替换(防串读不变量)。
 *  [解码层] 上游移除 decodeStorageRecord 后仍能整份读回;遇到没有展开器
 *           的打包行必须让读取失败,而不是静默丢掉整段助手输出。
 *
 * 运行：node --import tsx/esm scripts/verify-session-generations.tsx
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// Fixture safety: everything below writes under a fresh temp root pushed into
// DSH_TUI_SESSION_ROOT (which sessionsRoots() honors first). Assert it before
// the first write so a future edit cannot start mutating the user's real
// history — that has happened in this repo before (test keys landing in
// ~/.dsh-tui/last-used.json).
const rootA = mkdtempSync(join(tmpdir(), 'dsh-generations-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'dsh-generations-b-'))
process.env.DSH_TUI_SESSION_ROOT = rootA
const home = process.env.HOME ?? ''
for (const root of [rootA, rootB]) {
  if (home.length > 0 && root.startsWith(join(home, '.dsh'))) {
    console.error(`refusing to write fixtures inside the real session store: ${root}`)
    process.exit(1)
  }
}

type Row = { type: string; seq?: number; time?: number; data?: unknown; [k: string]: unknown }

/** One zstd frame per row — the shape the backend's batched append produces. */
function frames(rows: readonly Row[]): Buffer {
  return Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))))
}

function writeArtifact(root: string, ws: string, id: string, basename: string, rows: readonly Row[]): string {
  const dir = join(root, ws, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, basename)
  writeFileSync(path, basename.endsWith('.zstd')
    ? frames(rows)
    : `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  return path
}

const header = (id: string, extra: Record<string, unknown> = {}): Row => ({
  type: 'session',
  version: 3,
  id,
  createdAt: 1_700_000_000_000,
  cwd: '/tmp/project',
  isSeeded: false,
  delegationDepth: 0,
  ...extra,
})

const policy = (seq: number): Row => ({ type: 'sandbox/mode', seq, time: 1000 + seq, data: { mode: 'ask' } })
const userMsg = (seq: number, text: string): Row =>
  ({ type: 'user/message', seq, time: 1000 + seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const endSeed = (seq: number, inherited: boolean): Row =>
  ({ type: 'session/end-seed', seq, time: 1000 + seq, data: inherited ? { inherited: true } : {} })

const {
  findSessionLogFileAnyEncoding,
  readSessionEventsFromLog,
  readInheritedCutFrom,
  readInheritedCutForSession,
  readSessionTitleFromLog,
  resolveLocatedPath,
  SEED_BOUNDARY_MAX_SCANNED,
} = await import('../src/dsh-adapter/compat/sessionLog.js')

try {
  // ── 1. N-of-N：混合 v2 / v3 / 旧无世代名,跨 workspace 与跨 root ──────
  const plain = [header('gen-legacy'), policy(0), userMsg(1, 'legacy log')]
  writeArtifact(rootA, 'ws1', 'gen-legacy', 'session.jsonl.zstd', plain)
  writeArtifact(rootA, 'ws1', 'gen-v2only', 'session.v2.jsonl.zstd', [header('gen-v2only'), policy(0), userMsg(1, 'v2 log')])
  writeArtifact(rootA, 'ws2', 'gen-v3only', 'session.v3.jsonl.zstd', [header('gen-v3only'), policy(0), userMsg(1, 'v3 log')])
  writeArtifact(rootA, 'ws2', 'gen-uncompressed', 'session.v3.jsonl', [header('gen-uncompressed'), policy(0), userMsg(1, 'plain text log')])

  const everyId = ['gen-legacy', 'gen-v2only', 'gen-v3only', 'gen-uncompressed']
  const located = everyId.map(id => findSessionLogFileAnyEncoding(id))
  check(
    'N-of-N：混合世代全部定位到',
    located.every(entry => entry !== undefined),
    `${located.filter(e => e !== undefined).length}/${everyId.length}`,
  )
  check(
    'N-of-N：全部可读回事件',
    everyId.every(id => (readSessionEventsFromLog(id)?.events.length ?? 0) === 2),
  )
  check(
    '编码按内容判定，不按扩展名',
    located[0]?.compressed === true && located[3]?.compressed === false,
    `legacy=${located[0]?.compressed} plain=${located[3]?.compressed}`,
  )

  // ── 2. 最高可读世代优先 ───────────────────────────────────────────────
  // 同一会话目录里两代共存是迁移后的真实形态(真机上确认过):按名字先命中
  // 就会读到"旧"的那一份。
  writeArtifact(rootA, 'ws3', 'gen-both', 'session.v2.jsonl.zstd', [header('gen-both'), policy(0), userMsg(1, 'STALE v2')])
  writeArtifact(rootA, 'ws3', 'gen-both', 'session.v3.jsonl.zstd', [header('gen-both'), policy(0), userMsg(1, 'CURRENT v3')])
  const both = findSessionLogFileAnyEncoding('gen-both')
  check('两代共存时选 v3（不是 v2）', both?.path.endsWith('session.v3.jsonl.zstd') === true, both?.path.split('/').pop() ?? 'none')
  check('两代共存时读到的是新世代内容', readSessionTitleFromLog('gen-both')?.title === 'CURRENT v3')

  writeArtifact(rootA, 'ws3', 'gen-legacy-vs-v2', 'session.jsonl.zstd', [header('gen-legacy-vs-v2'), policy(0), userMsg(1, 'gen0')])
  writeArtifact(rootA, 'ws3', 'gen-legacy-vs-v2', 'session.v2.jsonl.zstd', [header('gen-legacy-vs-v2'), policy(0), userMsg(1, 'gen2')])
  check(
    '旧无世代名与 v2 共存时选 v2',
    findSessionLogFileAnyEncoding('gen-legacy-vs-v2')?.path.endsWith('session.v2.jsonl.zstd') === true,
  )

  // ── 3. 非规范名一律不选 ───────────────────────────────────────────────
  // 逐字镜像上游正则的收益就在这里：v0 / 前导零 / 大写 / 临时名 / 双后缀
  // 全部免费被拒。
  const junkDir = join(rootA, 'ws4', 'gen-junk')
  mkdirSync(junkDir, { recursive: true })
  for (const name of [
    'session.v0.jsonl.zstd',
    'session.V2.jsonl.zstd',
    'session.v02.jsonl.zstd',
    'session.jsonl.tmp',
    'session.v2.jsonl.zstd.tmp',
    'session.lock',
    'session.v2.json',
    'sessions.v2.jsonl.zstd',
  ]) writeFileSync(join(junkDir, name), frames([header('gen-junk'), userMsg(0, 'must not be read')]))
  check('只有非规范名的目录解析为 undefined', findSessionLogFileAnyEncoding('gen-junk') === undefined)

  // 非规范名不得压过同目录里的规范名
  writeArtifact(rootA, 'ws4', 'gen-junk-plus', 'session.v2.jsonl.zstd', [header('gen-junk-plus'), policy(0), userMsg(1, 'real')])
  writeFileSync(join(rootA, 'ws4', 'gen-junk-plus', 'session.v9.jsonl.zstd.tmp'), Buffer.from('garbage'))
  check(
    '规范名旁的临时名被忽略',
    findSessionLogFileAnyEncoding('gen-junk-plus')?.path.endsWith('session.v2.jsonl.zstd') === true,
  )

  // ── 4. 上游解析器对照（有 dsh-session-format 时才跑） ─────────────────
  // 我们镜像了上游的 CANONICAL_LOG_FILENAME。这条断言是让这份复制保持诚实
  // 的唯一机制；上游包不在这棵树里时跳过，而不是失败。
  let oracle: ((name: string) => number | undefined) | undefined
  try {
    const mod = await import('@deepseek-ai/dsh-session-format') as Record<string, unknown>
    const candidate = mod['parseSessionFormatLogFilename']
    if (typeof candidate === 'function') oracle = candidate as (name: string) => number | undefined
  } catch {
    oracle = undefined
  }
  if (oracle === undefined) {
    console.log('SKIP: 上游解析器对照（@deepseek-ai/dsh-session-format 不可解析）')
  } else {
    const table = [
      'session.jsonl', 'session.v1.jsonl', 'session.v2.jsonl', 'session.v3.jsonl', 'session.v10.jsonl',
      'session.v0.jsonl', 'session.v02.jsonl', 'session.V2.jsonl', 'session.jsonl.tmp', 'sessions.jsonl',
    ]
    // 我们的解析器不导出，等价地用一个只含该名字的目录去问定位器。
    const probeDir = join(rootB, 'oracle')
    let agree = true
    const disagreements: string[] = []
    for (const name of table) {
      const id = `oracle-${name.replace(/[^a-z0-9]/gi, '')}`
      const dir = join(probeDir, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), `${JSON.stringify(header(id))}\n`)
      const previous = process.env.DSH_TUI_SESSION_ROOT
      process.env.DSH_TUI_SESSION_ROOT = rootB
      const ours = findSessionLogFileAnyEncoding(id) !== undefined
      process.env.DSH_TUI_SESSION_ROOT = previous
      const theirs = oracle(name) !== undefined
      if (ours !== theirs) { agree = false; disagreements.push(`${name}: ours=${ours} upstream=${theirs}`) }
    }
    check('与上游 parseSessionFormatLogFilename 完全一致', agree, disagreements.join('; '))
  }

  // ── 5. 继承切点：从 end-seed{inherited:true} 推导 ─────────────────────
  // 真实 store 上没有任何 header 还带 seedLength(v2 时期的 fork 也没有),
  // 所以这是每个 fork 唯一的来源。
  writeArtifact(rootA, 'ws5', 'cut-fork', 'session.v3.jsonl.zstd', [
    header('cut-fork', { parentSession: 'cut-parent', isSeeded: true }),
    policy(0), policy(1), policy(2), endSeed(3, true), userMsg(4, 'own content'),
  ])
  check('切点 = end-seed{inherited:true} 的 seq', readInheritedCutForSession('cut-fork') === 3, `cut=${readInheritedCutForSession('cut-fork')}`)

  // 裸 end-seed 不是 fork 信号：真实 store 上有 12 个无父会话同样带这个事件。
  writeArtifact(rootA, 'ws5', 'cut-bare', 'session.v3.jsonl.zstd', [
    header('cut-bare'), policy(0), policy(1), policy(2), endSeed(3, false), userMsg(4, 'not a fork'),
  ])
  check('裸 end-seed（data:{}）不产生切点', readInheritedCutForSession('cut-bare') === undefined)

  // 没有 end-seed 的会话（含 subagent 子会话）也不产生切点。
  writeArtifact(rootA, 'ws5', 'cut-none', 'session.v3.jsonl.zstd', [
    header('cut-none', { parentSession: 'cut-parent', origin: 'subagent' }), policy(0), userMsg(1, 'delegated run'),
  ])
  check('无 end-seed 的会话不产生切点', readInheritedCutForSession('cut-none') === undefined)

  // 预算耗尽必须报 undefined（回到"游离"行为），不能猜。
  const farRows: Row[] = [header('cut-far')]
  for (let seq = 0; seq < 40; seq += 1) farRows.push(policy(seq))
  farRows.push(endSeed(40, true))
  writeArtifact(rootA, 'ws5', 'cut-far', 'session.v3.jsonl.zstd', farRows)
  const far = findSessionLogFileAnyEncoding('cut-far')!
  check('预算内能找到较远的边界', readInheritedCutFrom(far) === 40, `cut=${readInheritedCutFrom(far)}`)
  check('预算耗尽报 undefined 而不是猜', readInheritedCutFrom(far, 5) === undefined)
  check('探测预算常量为正', SEED_BOUNDARY_MAX_SCANNED > 0, String(SEED_BOUNDARY_MAX_SCANNED))

  // 全量读顺带免费带回同一个切点。
  const readBack = readSessionEventsFromLog('cut-fork')
  check('全量读回报同一个切点', readBack?.inheritedCut === 3, `cut=${readBack?.inheritedCut}`)

  // 切点之后不再按 seq 去重：切点之上的事件是本会话自己的，只是共用父会话
  // 的 seq 空间。此前长父会话的分叉会几乎看不到自己的内容。
  const skipped = readSessionEventsFromLog('cut-fork', 100, 4096, 99)
  check(
    '切点终止继承前缀跳过（自己的事件保住）',
    skipped !== undefined && skipped.events.some(event => (event as unknown as Row).type === 'user/message'),
    `len=${skipped?.events.length}`,
  )

  // ── 6. locate() 世代纠正 + 防串读 ────────────────────────────────────
  const v2Path = writeArtifact(rootA, 'ws6', 'locate-v2', 'session.v2.jsonl.zstd', [
    header('locate-v2'), policy(0), userMsg(1, 'v2 body'),
  ])
  const deadHint = join(rootA, 'ws6', 'locate-v2', 'session.v3.jsonl.zstd')
  check('locate() 指向缺失世代时在同目录内纠正', resolveLocatedPath(deadHint)?.path === v2Path, resolveLocatedPath(deadHint)?.path ?? 'none')
  check('locate() 命中真实产物时原样返回', resolveLocatedPath(v2Path)?.path === v2Path)
  // 指向别的目录不得被同 id 副本悄悄替换。
  const foreignHint = join(rootB, 'elsewhere', 'locate-v2', 'session.v3.jsonl.zstd')
  check('locate() 指向别处不得回落到同 id 副本', resolveLocatedPath(foreignHint)?.path === undefined)

  // ── 7. 解码器缺失回退 ────────────────────────────────────────────────
  // 上游 0.1.5 移除了 decodeStorageRecord;它经 createRequire 懒取,类型门禁
  // 看不见。真机全量扫描(22192 行)里 v2/v3 都没有打包行,所以本地一行一
  // 事件解码足够;但没有展开器时遇到打包行必须失败,而不是丢掉整段输出。
  writeArtifact(rootA, 'ws7', 'decode-plainrows', 'session.v3.jsonl.zstd', [
    header('decode-plainrows'), policy(0), userMsg(1, 'one row per event'),
  ])
  check('无打包行的 v3 日志整份读回', readSessionEventsFromLog('decode-plainrows')?.events.length === 2)

  writeArtifact(rootA, 'ws7', 'decode-packed', 'session.v3.jsonl.zstd', [
    header('decode-packed'),
    policy(0),
    { type: 'text-chunks', seq: 1, time: 1001, data: { chunks: ['a', 'b'] } },
  ])
  const packed = readSessionEventsFromLog('decode-packed')
  // 这棵树里 rc.2 仍导出 decodeStorageRecord,它会正常展开;alpha.1 之后没有
  // 展开器,必须 failed。两种结果都可接受,静默丢掉那一行不可接受。
  const expandedByUpstream = packed !== undefined && packed.failed !== true && packed.events.length >= 2
  const failedClosed = packed?.failed === true
  check(
    '打包行要么由上游展开，要么让读取失败（绝不静默丢弃）',
    expandedByUpstream || failedClosed,
    failedClosed ? 'failed-closed' : `expanded len=${packed?.events.length}`,
  )

  // ── 8. 按编码分别追加标题 ────────────────────────────────────────────
  const { appendSessionTitle } = await import('../src/dsh-adapter/compat/sessionLog.js')
  const v3TitlePath = writeArtifact(rootA, 'ws8', 'title-v3', 'session.v3.jsonl.zstd', [
    header('title-v3'), policy(0), userMsg(1, 'first prompt'),
  ])
  const beforeBytes = readFileSync(v3TitlePath)
  check('v3 产物上改名成功', appendSessionTitle('title-v3', 'renamed v3') === 'appended')
  const afterBytes = readFileSync(v3TitlePath)
  check('改名只追加，既有字节不变', afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes) && afterBytes.length > beforeBytes.length)
  check('改名后读回新标题', readSessionTitleFromLog('title-v3')?.title === 'renamed v3')

  const plainTitlePath = writeArtifact(rootA, 'ws8', 'title-plain', 'session.v3.jsonl', [
    header('title-plain'), policy(0), userMsg(1, 'plain prompt'),
  ])
  check('未压缩产物上改名成功', appendSessionTitle('title-plain', 'renamed plain') === 'appended')
  check('未压缩产物改名后读回新标题', readSessionTitleFromLog('title-plain')?.title === 'renamed plain')
  check(
    '未压缩产物追加的是文本行，不是 zstd 帧',
    !readFileSync(plainTitlePath).subarray(beforeBytes.length).includes(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])),
  )

  // ── 9. 安全兜底 ──────────────────────────────────────────────────────
  check('不安全的 session id 被拒', findSessionLogFileAnyEncoding('../escape') === undefined)
  check('不存在的 id 返回 undefined', findSessionLogFileAnyEncoding('gen-nosuch') === undefined)
} finally {
  delete process.env.DSH_TUI_SESSION_ROOT
  rmSync(rootA, { recursive: true, force: true })
  rmSync(rootB, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nverify-session-generations: ALL PASS' : `\nverify-session-generations: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
