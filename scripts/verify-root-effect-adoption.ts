/**
 * verify-root-effect-adoption — `root.effect` 作为「被活动 fiber 认领的效应」准入。
 *
 * 官方 agent-team 故意经根注册会话投影：投影必须活过插件自身效应的拆解，
 * 直到 `disposeRuntime()` 结束（上游 3759ea5dfe）。一律拒绝 `root.effect`
 * 只会让这类插件启动失败，所以改为认领：
 *
 *   A. 插件活动期调用 `root.effect` 不再抛错，且拿回的 disposer 可用；
 *   B. 插件自己 dispose 过的，不会被二次 dispose；
 *   C. 插件没 dispose 的，在该 fiber **完全卸载之后**被回收（不是与插件
 *      自身效应同批 LIFO 拆——那会把根效应从仍在使用它的异步 disposer
 *      底下抽走，正是上游那个修复要避免的）；
 *   D. 其余根能力仍然拒绝（root.plugin / root.inject / root.registry.delete /
 *      root.reflect.set / root fiber 的 restart·dispose·update）；
 *   E. 宿主自己调用 `root.effect` 不受影响。
 *
 * 运行：node --import tsx/esm scripts/verify-root-effect-adoption.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { compositionRoot } from '../src/dsh-adapter/host-access.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

// ── A/B/C: 认领、插件自行 dispose、卸载后兜底回收 ────────────────────────
{
  const root = new Context()
  root.logger.warn = () => undefined
  root.logger.error = () => undefined
  // Arm the guards exactly as the TUI host does.
  compositionRoot(root)

  const disposed: string[] = []
  let selfDisposer: (() => unknown) | undefined
  let adoptError: unknown

  const fiber = root.plugin({
    name: 'root-effect-probe',
    apply(ctx: Context) {
      try {
        // The shape agent-team uses: a root-scoped effect that must outlive
        // this plugin's own effect teardown.
        selfDisposer = ctx.root.fiber.effect(() => {
          return () => { disposed.push('self') }
        }) as () => unknown
        ctx.root.fiber.effect(() => {
          return () => { disposed.push('leaked') }
        })
      } catch (error) {
        adoptError = error
      }
    },
  })

  await settle()

  check('插件活动期的 root.effect 不再抛错', adoptError === undefined, adoptError === undefined ? '' : String(adoptError))
  check('拿回的是可调用的 disposer', typeof selfDisposer === 'function')

  if (typeof selfDisposer === 'function') selfDisposer()
  check('插件自行 dispose 立即生效', disposed.includes('self'), disposed.join(','))
  check('未 dispose 的根效应此时仍然活着', !disposed.includes('leaked'), disposed.join(','))

  const beforeUnload = [...disposed]
  await fiber.dispose()
  await settle()

  check('卸载后回收了泄漏的根效应', disposed.includes('leaked'), disposed.join(','))
  check('已 dispose 的不会被二次 dispose', disposed.filter(e => e === 'self').length === 1, disposed.join(','))
  check('回收发生在卸载之后而不是之前', !beforeUnload.includes('leaked'))
}

// ── D: 其余根能力仍然拒绝 ────────────────────────────────────────────────
{
  const root = new Context()
  root.logger.warn = () => undefined
  root.logger.error = () => undefined
  compositionRoot(root)

  const rejected: Record<string, boolean> = {}
  const record = (name: string, attempt: () => unknown): void => {
    try {
      attempt()
      rejected[name] = false
    } catch (error) {
      rejected[name] = error instanceof Error && error.message.includes('unavailable from a plugin activation')
    }
  }

  const fiber = root.plugin({
    name: 'root-capability-probe',
    apply(ctx: Context) {
      record('root.plugin', () => ctx.root.registry.plugin({ name: 'nested', apply() {} }))
      record('root.registry.delete', () => ctx.root.registry.delete({ name: 'nested', apply() {} }))
      record('root.reflect.set', () => ctx.root.reflect.set('probeValue', undefined, 1))
      record('root.fiber.restart', () => ctx.root.fiber.restart())
      record('root.fiber.dispose', () => ctx.root.fiber.dispose())
      record('root.fiber.update', () => ctx.root.fiber.update({}))
    },
  })

  await settle()

  for (const capability of ['root.plugin', 'root.registry.delete', 'root.reflect.set', 'root.fiber.restart', 'root.fiber.dispose', 'root.fiber.update']) {
    check(`${capability} 仍然拒绝`, rejected[capability] === true, String(rejected[capability]))
  }

  await fiber.dispose().catch(() => undefined)
}

// ── E: 宿主自身调用不受影响 ─────────────────────────────────────────────
{
  const root = new Context()
  root.logger.warn = () => undefined
  root.logger.error = () => undefined
  compositionRoot(root)

  let hostDisposed = false
  let hostError: unknown
  let dispose: unknown
  try {
    dispose = root.fiber.effect(() => () => { hostDisposed = true })
  } catch (error) {
    hostError = error
  }
  check('宿主自身的 root.effect 不被拒绝', hostError === undefined, hostError === undefined ? '' : String(hostError))
  if (typeof dispose === 'function') (dispose as () => unknown)()
  check('宿主自身的 disposer 原样可用', hostDisposed)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
