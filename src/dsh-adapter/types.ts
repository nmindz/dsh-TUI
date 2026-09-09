/**
 * Type-only re-exports of the official upstream surface for UI layers.
 *
 * UI modules (screens/, components/, ink/, hooks/, utils/) must never import
 * `@deepseek-ai/*` directly — they import types from here. This keeps the
 * upstream coupling in one tree (src/dsh-adapter/) so an upstream prerelease bump
 * breaks exactly one module, never the whole UI.
 */
export type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo as UpstreamLlmProviderInfo } from '@deepseek-ai/dsh-llm'

/**
 * A `/model` top-level row: the registry's provider info plus whether a
 * profile actually declares the route.
 *
 * The registry serves every mounted route, including catalog families
 * nobody configured and OAuth routes claimed while signed out, so the flag
 * is what separates "offer this" from "only name it". Keeping the
 * unconfigured entries in the list (rather than dropping them) preserves
 * their display names, so a route that earns a row by listing models still
 * renders as "OpenAI Codex" instead of the raw route key.
 */
export interface ModelProviderInfo extends UpstreamLlmProviderInfo {
  /** False when no profile declares the route. Undefined on hosts that do
   *  not tag, which are treated as configured for backward compatibility. */
  readonly configured?: boolean
}
export type { Agent, AgentHandle, AgentStatus, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
export type { SessionId, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
export type { CommandRuntime } from '@deepseek-ai/dsh-commands'
export type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
export type { AgentSetup } from '@deepseek-ai/dsh-agent'
export type { Context } from '@deepseek-ai/cordis'
export type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * Trajectory projection types. Not upstream types, but the same rule applies:
 * the scene is pure UI over this shape and never reaches into the projection's
 * own modules (which do import `@deepseek-ai/*`).
 */
export type {
  HotspotRow,
  HotspotSort,
  TrajAggregate,
  TrajBurst,
  TrajKind,
  TrajNode,
  TrajStatus,
  TrajTokens,
  TrajTotals,
  WaveBand,
  WaveBucket,
  WaveChannel,
  WaveProjection,
} from './trajectory/types.js'
