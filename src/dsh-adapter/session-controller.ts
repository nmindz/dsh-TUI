/**
 * A `sessionController` for terminal-only profiles.
 *
 * `@deepseek-ai/dsh-schedule` injects `sessionController`, and the only
 * implementation that provides it is the web app's
 * `@deepseek-ai/dsh-api-session-controller`. That row cannot mount in a
 * TUI-only profile: it injects `fileUploads`, which needs `connection`, which
 * needs `webRuntime`. Without a provider, schedule never activates and its
 * `schedule_*` tools never reach the agent.
 *
 * Schedule uses exactly one method — `resolveAgent(sessionId)` — then
 * `agent.followup(message)` and `ctx.sessions.flush(agent.session)`. So this
 * service implements that one method and nothing else.
 *
 * ## Live agents only, deliberately
 *
 * The official resolver falls back to a deduplicated COLD RESUME when the
 * session is not live. This one must not. Several TUI processes plus `web` and
 * `web-next` can run at once over the same `~/.dsh/sessions` and
 * `~/.dsh/storages`; schedule has no cross-process lease and each host keeps
 * its own in-memory task table. A background cold resume here would let two
 * hosts drive the same session, and would resurrect a session the user closed.
 *
 * So an identity that is not live IN THIS PROCESS returns `session/not-found`.
 * Schedule treats that as a task failure. A failed task does not re-arm its
 * timer, but it also does not clear the record: the task stays `active` with a
 * due `scheduledAt`, so the next scan after the session is open again — the
 * scan loop runs on schedule's own interval, and reopening a session in this
 * TUI makes its agent live — picks it up and delivers then. Late, not lost.
 *
 * Subagent-owned identities are refused for the same reason the official
 * resolver refuses them: those sessions belong to subagent routing.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The failure half of {@link TuiSessionAgentResult}. */
export interface TuiSessionAgentError {
  readonly code: 'session/not-found' | 'session/agent-busy'
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** Mirrors the official `ApiSessionAgentResult` union schedule destructures. */
export type TuiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: TuiSessionAgentError }

export const name = 'dsh-tui-session-controller'

/**
 * Shaped like the harness's `RemoteError` where schedule can observe it: a
 * thrown value carrying `code`/`data`. Schedule does `throw resolved.error`,
 * so this has to be a real Error — a plain object would surface as
 * "[object Object]" in the task's failure record.
 *
 * Built locally rather than imported from `@deepseek-ai/dsh-typert-protocol`:
 * that package is a dev-only dependency here (the TUI ships no Remote
 * namespace), and taking a runtime dependency on it just to construct an
 * error would put it in the peer set for every terminal install.
 */
class TuiSessionError extends Error implements TuiSessionAgentError {
  readonly code: TuiSessionAgentError['code']
  readonly data?: Readonly<Record<string, unknown>>

  constructor(code: TuiSessionAgentError['code'], message: string, data?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'TuiSessionError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/**
 * Whether generic session routing must leave this identity to subagent
 * routing — the same rule as the official resolver's
 * `hasApiSessionSubagentOwner`.
 */
function ownedBySubagentRouting(ctx: Context, agent: Agent): boolean {
  const header = agent.session.header
  if (header.origin === 'subagent') return true
  const parentId = header.parentSession
  if (parentId === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/** Resolves scheduled deliveries against the agents live in this process. */
export class TuiSessionController extends Service {
  static inject = ['agents']

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  /**
   * Resolve one session identity to its live agent.
   * @param sessionId - The session a due task was recorded against.
   * @returns The live agent, or a failure when it is not live here.
   */
  async resolveAgent(sessionId: SessionId): Promise<TuiSessionAgentResult> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      return {
        error: new TuiSessionError(
          'session/not-found',
          `session "${sessionId}" is not open in this terminal`,
          { reason: 'the terminal resolves only sessions live in its own process' },
        ),
      }
    }
    if (ownedBySubagentRouting(this.ctx, agent)) {
      return {
        error: new TuiSessionError(
          'session/agent-busy',
          `session "${sessionId}" is owned by subagent routing`,
          { reason: 'use subagent delivery for this child session' },
        ),
      }
    }
    return { agent }
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(TuiSessionController)
}

export default TuiSessionController
