/**
 * The host `shell` service seen through the TUI's `{ resolve, run }` command
 * shell. Since harness 0.1.7 an executor spawns through `execute(spec)` and a
 * foreground run's collected output comes from the handle's `result()`.
 * @module @deepseek-harness-tui/dsh-tui/host-shell
 */

/** The collected result of one foreground command. */
export interface CommandShellResult {
  readonly exitCode: number | null
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
  readonly timedOut: boolean
}

/** A command shell: resolve a request into a spec, then run it to completion. */
export interface CommandShell {
  resolve(request: { command: string; workdir?: string; timeoutMs: number }): unknown
  run(spec: unknown): Promise<CommandShellResult>
}

interface ShellExecutorLike {
  resolve(request: { command: string; workdir?: string; timeoutMs: number }): unknown
  execute?(spec: unknown): Promise<{ result(): Promise<CommandShellResult> }>
  run?(spec: unknown): Promise<CommandShellResult>
}

/**
 * Adapt the host shell service, when one is mounted.
 * @param service - `ctx.get('shell')`.
 * @returns A command shell, or undefined when the service is absent or unrecognized.
 */
export function hostCommandShell(service: unknown): CommandShell | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const executor = service as ShellExecutorLike
  if (typeof executor.resolve !== 'function') return undefined
  const { execute, run } = executor
  if (typeof execute === 'function') {
    return {
      resolve: request => executor.resolve(request),
      run: async spec => (await execute.call(executor, spec)).result(),
    }
  }
  if (typeof run === 'function') {
    return { resolve: request => executor.resolve(request), run: spec => run.call(executor, spec) }
  }
  return undefined
}
