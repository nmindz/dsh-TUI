/**
 * 页脚状态段的台账行为：幂等重设与调用者归属。
 *
 *   A. 内容不变的重复 setSegment 不写台账、不改 store（插件按定时器刷新，
 *      每 tick 一对 release/bind 曾把 ledger 写到 27MB）；
 *   B. 文本变化只写一条 replace；真正 dispose 仍写一条 release；
 *   C. 已准入插件不传 identity 也能归属到 componentId——归属取解析出的
 *      caller，不是猜测的导出名；
 *   D. 幂等返回的 disposer 仍然有效，且重复注册不让 effect 无界增长。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-status-segment-ledger.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-segment-ledger-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'

const { Context } = await import('@deepseek-ai/cordis')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const { TuiEffectLedgerRuntime, EFFECT_LEDGER_FILE } = await import('../src/dsh-adapter/effect-ledger.js')
const { TuiStatusRuntime, getHostStatusStore } = await import('../src/dsh-adapter/status.js')
const { mountAdmitted, testManifest } = await import('../src/dsh-adapter/plugin-test-utils.js')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** Ledger records for one resource id, in write order. */
function records(id: string): Record<string, unknown>[] {
  if (!existsSync(EFFECT_LEDGER_FILE)) return []
  return readFileSync(EFFECT_LEDGER_FILE, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => {
      const resource = entry.resource as { id?: unknown } | undefined
      return resource?.id === id
    })
}

const root = new Context()
root.plugin(pluginHostRow as never)
root.plugin(TuiEffectLedgerRuntime as never)
root.plugin(TuiStatusRuntime as never)
await sleep(40)

const COMPONENT = 'segment-probe'
const { context: plugin, fiber } = await mountAdmitted(
  root as never,
  COMPONENT,
  testManifest({ id: COMPONENT }),
)
const status = plugin.get('tuiStatus') as {
  setSegment(
    segment: { key: string; text: string; color?: string; order?: number },
    placement?: 'footer-left' | 'footer-right',
  ): (() => void) | undefined
}
const store = getHostStatusStore(root.get('tuiStatus') as never)
const KEY = 'segment-probe:git'

// A. Identical re-registration is a no-op.
const first = status.setSegment({ key: KEY, text: '🌿 main' })
check('the first setSegment is admitted', typeof first === 'function')
const afterFirst = records(KEY).length
check('the first setSegment writes exactly one record', afterFirst === 1, `n=${afterFirst}`)

for (let i = 0; i < 25; i++) status.setSegment({ key: KEY, text: '🌿 main' })
const afterRepeats = records(KEY).length
check(
  '25 identical re-registrations write nothing further',
  afterRepeats === afterFirst,
  `before=${afterFirst} after=${afterRepeats}`,
)
check(
  'the segment is still registered after the no-ops',
  store?.getSegmentSnapshot().some(entry => entry.key === KEY) === true,
)

// D. The idempotent path returns a usable disposer and does not grow effects.
const repeat = status.setSegment({ key: KEY, text: '🌿 main' })
check('an unchanged re-registration still returns a disposer', typeof repeat === 'function')

// B. A real change writes exactly one more record.
status.setSegment({ key: KEY, text: '🌿 main*' })
const afterChange = records(KEY).length
check(
  'changed text writes exactly one more record',
  afterChange === afterRepeats + 1,
  `${afterRepeats} -> ${afterChange}`,
)
const changeOp = records(KEY).at(-1)?.operation
check('the changed-text record is a replace', changeOp === 'replace', String(changeOp))

// A colour-only change is still a change.
status.setSegment({ key: KEY, text: '🌿 main*', color: 'remember' })
const afterColor = records(KEY).length
check('a colour-only change is not treated as identical', afterColor === afterChange + 1,
  `${afterChange} -> ${afterColor}`)

// D (cont). Replacing repeatedly must not grow the caller's effect list:
// the plugin now upserts instead of disposing first, so a long session would
// otherwise leak one effect per content change.
const effectsOf = (): number => {
  const fiberEffects = (plugin as unknown as { fiber?: { getEffects?: () => unknown[] } }).fiber
  return fiberEffects?.getEffects?.().length ?? -1
}
const effectsBefore = effectsOf()
for (let i = 0; i < 30; i++) status.setSegment({ key: KEY, text: `🌿 main-${i}` })
const effectsAfter = effectsOf()
check(
  '30 replaces do not grow the effect list',
  effectsBefore < 0 || effectsAfter <= effectsBefore + 1,
  `before=${effectsBefore} after=${effectsAfter}`,
)
const replaceRecords = records(KEY).filter(entry => entry.operation === 'replace').length
check('each replace writes exactly one record', replaceRecords >= 30, `replaces=${replaceRecords}`)
check(
  'replaces write no release records',
  records(KEY).filter(entry => entry.operation === 'release').length === 0,
  `releases=${records(KEY).filter(entry => entry.operation === 'release').length}`,
)

// C. Attribution: the admitted component, without passing identity.
const bindRecord = records(KEY).find(entry => entry.operation === 'bind')
check(
  'an admitted plugin is attributed without passing identity',
  bindRecord?.pluginId === COMPONENT,
  `pluginId=${String(bindRecord?.pluginId)}`,
)
check(
  'the activation instance is not a placeholder',
  typeof bindRecord?.activationInstance === 'string'
    && bindRecord.activationInstance !== 'undeclared',
  String(bindRecord?.activationInstance),
)

// B (cont). A genuine dispose still records a release.
const current = status.setSegment({ key: KEY, text: '🌿 main*', color: 'remember' })
const beforeRelease = records(KEY).length
current?.()
await sleep(20)
const releases = records(KEY).filter(entry => entry.operation === 'release')
check('an explicit dispose records exactly one release', releases.length === 1, `n=${releases.length}`)
check(
  'the release is the only record the dispose added',
  records(KEY).length === beforeRelease + 1,
  `${beforeRelease} -> ${records(KEY).length}`,
)
check(
  'the segment is gone from the store after dispose',
  store?.getSegmentSnapshot().some(entry => entry.key === KEY) !== true,
)

// Re-binding the same key after a dispose is a fresh bind, not a no-op.
status.setSegment({ key: KEY, text: '🌿 main*', color: 'remember' })
const afterRebind = records(KEY).filter(entry => entry.operation === 'bind').length
check('re-binding after dispose writes a new bind', afterRebind === 2, `binds=${afterRebind}`)

await Promise.resolve(fiber.dispose())
await sleep(20)
rmSync(fakeHome, { recursive: true, force: true })

if (failed === 0) {
  console.log(`\nstatus-segment-ledger: all checks passed`)
} else {
  console.error(`\nstatus-segment-ledger: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)
