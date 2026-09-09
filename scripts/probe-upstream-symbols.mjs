/**
 * probe-upstream-symbols — 取证探针，不是有界门禁。
 *
 * 报告 adapter 通过"类型系统看不见的路径"触达的每个上游符号在给定解析
 * 锚点上是否真的存在。这类路径有两种：`createRequire()` 懒取(编译期完全
 * 不可见)，以及 `as` 断言(编译期被静音)。两者都能让 `pnpm compile` 全绿
 * 而运行时在第一行就抛错。
 *
 * 真实教训：`@deepseek-ai/dsh-session` 在 0.1.5-alpha.1 移除了
 * `decodeStorageRecord`。它经 `createRequire` 懒取，所以 71 个构建门禁、
 * `tsc --noEmit`、`verify:contract` 全部通过，而每个会话日志的第一行都会
 * 抛 TypeError，被 catch 吞掉后每个会话降级为"不可读"。这个探针是唯一
 * 会先看到它的东西。
 *
 * 不抛错：打印在场情况并给出退出码，好在任意目标树上直接跑。默认锚点是
 * 真正运行 TUI 的那棵树($DSH_HOME/profiles/tui)，而不是仓库自己的 dev
 * 树 —— 两者版本可能相差数条线，这正是本探针要暴露的。
 *
 * 运行：
 *   node scripts/probe-upstream-symbols.mjs
 *   node scripts/probe-upstream-symbols.mjs --anchor <path>
 *   node scripts/probe-upstream-symbols.mjs --anchor <path> --strict   # 缺失即非零退出
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}
const strict = argv.includes('--strict')

const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const anchors = []
const explicit = flag('--anchor')
if (explicit !== undefined) {
  anchors.push({ label: 'explicit', path: resolve(explicit) })
} else {
  anchors.push({ label: 'profile (runtime)', path: join(dshHome, 'profiles', 'tui', 'cordis.yml') })
  anchors.push({ label: 'repo (dev tree)', path: resolve(import.meta.dirname, '..', 'lib', 'types', 'index.js') })
}

/**
 * Every upstream symbol the adapter reaches through a lazy require or a cast.
 * `required: false` marks one the adapter tolerates being absent (it probes
 * and degrades); `required: true` marks one whose absence breaks a feature.
 * Keep this table in step with the lazy/cast call sites it names.
 */
const MODULE_SYMBOLS = [
  {
    module: '@deepseek-ai/dsh-session',
    symbols: [
      { name: 'SESSION_FORMAT_VERSION', kind: 'value', required: true, site: 'compat/sessionLog (generation naming)' },
      { name: 'KNOWN_SESSION_EVENT_TYPES', kind: 'set', required: true, site: 'compat/sessionLog ensureLegacySessionEventTypes' },
      { name: 'decodeStorageRecord', kind: 'function', required: false, site: 'compat/sessionLog decodeStorageRecord (probed; local one-row fallback)' },
      { name: 'packChunkRuns', kind: 'function', required: false, site: 'packed-row layout (retired at 0.1.5)' },
      { name: 'Session', kind: 'function', required: true, site: 'compat/liveSession' },
      { name: 'SessionId', kind: 'function', required: true, site: 'adapter-wide' },
    ],
  },
]

/**
 * Prototype members reached on a live instance rather than as exports.
 *
 * Grouped as EITHER-OR sets, because the adapter deliberately supports both
 * shapes: rc.2 exposes `events`, the 0.1.5 line replaced it with
 * `snapshotEvents`, and compat/liveSession branches on whichever is there.
 * Flagging each independently would report a false failure on every tree —
 * what actually matters is that at least one member of the set survives.
 */
const PROTOTYPE_ALTERNATIVES = [
  {
    module: '@deepseek-ai/dsh-session',
    owner: 'Session',
    members: ['snapshotEvents', 'events'],
    site: 'compat/liveSession snapshotLiveSessionEvents',
  },
]

const rows = []
let missingRequired = 0
let resolvedAnchors = 0

for (const anchor of anchors) {
  if (!existsSync(anchor.path)) {
    rows.push({ anchor: anchor.label, module: '-', symbol: '-', status: 'anchor missing', detail: anchor.path })
    continue
  }
  let req
  try {
    req = createRequire(anchor.path)
  } catch (error) {
    rows.push({ anchor: anchor.label, module: '-', symbol: '-', status: 'anchor unusable', detail: String(error) })
    continue
  }
  resolvedAnchors += 1
  for (const entry of MODULE_SYMBOLS) {
    let mod
    // The exports map may not expose ./package.json, so resolve the entry and
    // walk up to the nearest manifest instead of requiring the subpath.
    let version = '?'
    try {
      let dir = dirname(req.resolve(entry.module))
      for (let hop = 0; hop < 6; hop += 1) {
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest)) {
          version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? '?'
          break
        }
        dir = dirname(dir)
      }
    } catch {
      version = '?'
    }
    try {
      mod = req(entry.module)
    } catch (error) {
      rows.push({ anchor: anchor.label, module: entry.module, symbol: '(module)', status: 'UNRESOLVED', detail: String(error).slice(0, 80) })
      if (entry.symbols.some(symbol => symbol.required)) missingRequired += 1
      continue
    }
    for (const symbol of entry.symbols) {
      const value = mod?.[symbol.name]
      const present = symbol.kind === 'set'
        ? value !== undefined && typeof value?.add === 'function'
        : symbol.kind === 'function'
          ? typeof value === 'function'
          : value !== undefined
      const status = present ? 'present' : symbol.required ? 'MISSING (required)' : 'absent (tolerated)'
      if (!present && symbol.required) missingRequired += 1
      rows.push({
        anchor: `${anchor.label} @ ${version}`,
        module: entry.module,
        symbol: symbol.name,
        status,
        detail: present ? symbol.site : `expected by ${symbol.site}`,
      })
    }
  }
  for (const group of PROTOTYPE_ALTERNATIVES) {
    let owner
    try {
      owner = req(group.module)?.[group.owner]
    } catch {
      owner = undefined
    }
    // Inspect the DESCRIPTOR, never read the value: several of these members
    // are accessors, and reading one off the prototype invokes the getter
    // with `this === prototype` (rc.2's `events` throws "this.log is not
    // iterable"). A probe must not have side effects on what it probes.
    const has = name => {
      let cursor = owner?.prototype
      while (cursor !== undefined && cursor !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, name)
        if (descriptor !== undefined) {
          return typeof descriptor.value === 'function' || typeof descriptor.get === 'function'
        }
        cursor = Object.getPrototypeOf(cursor)
      }
      return false
    }
    const found = group.members.filter(has)
    if (found.length === 0) missingRequired += 1
    rows.push({
      anchor: anchor.label,
      module: group.module,
      symbol: `${group.owner}.prototype.{${group.members.join('|')}}`,
      status: found.length > 0 ? `present: ${found.join(',')}` : 'MISSING (all alternatives)',
      detail: group.site,
    })
  }
}

const width = key => Math.max(...rows.map(row => String(row[key]).length), key.length)
const widths = { anchor: width('anchor'), module: width('module'), symbol: width('symbol'), status: width('status') }
console.log(
  `${'anchor'.padEnd(widths.anchor)}  ${'module'.padEnd(widths.module)}  ${'symbol'.padEnd(widths.symbol)}  ${'status'.padEnd(widths.status)}  site`,
)
for (const row of rows) {
  console.log(
    `${String(row.anchor).padEnd(widths.anchor)}  ${String(row.module).padEnd(widths.module)}  ${String(row.symbol).padEnd(widths.symbol)}  ${String(row.status).padEnd(widths.status)}  ${row.detail}`,
  )
}

console.log(`\nanchors resolved: ${resolvedAnchors}/${anchors.length}; required symbols missing: ${missingRequired}`)
if (resolvedAnchors === 0) {
  console.log('no anchor resolved — nothing was probed (this is a forensic tool, not a gate)')
}
process.exit(strict && missingRequired > 0 ? 1 : 0)
