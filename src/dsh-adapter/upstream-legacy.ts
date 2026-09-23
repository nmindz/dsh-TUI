/**
 * Shapes the durable session log (or an older peer) still carries that the
 * CURRENT upstream types no longer declare.
 *
 * Two different kinds of drift live here, and both must degrade rather than
 * disappear, because the TUI reads history written by every earlier line:
 *
 *  - **Retired event types.** `assistant/chunk` left the `SessionEvent`
 *    union when assistant streaming stopped being persisted as separate
 *    events (a v3 row nests the stream inside `assistant/message`). Old
 *    logs are full of them, so the projection/tree/transcript branches that
 *    read them stay — they just cannot be typed by extracting from a union
 *    that no longer has the member. `Extract<SessionEvent, {type:'…'}>`
 *    silently collapses to `never`, which is what turned one retired type
 *    into a cascade of "property does not exist on type 'never'".
 *  - **Retired header fields.** `EpochHeader.system` went away once the
 *    system prompt became derived history (surface node 0, a
 *    `system/message` event). Reading it structurally keeps the older line
 *    working and yields `undefined` on the newer one.
 *  - **Retired message shapes.** Session V4 dropped the `tool-result` block
 *    (tool results are `role: 'tool'` messages) and the catch-all `plugin`
 *    source (compaction checkpoints are `compact-checkpoint`). V3 logs keep
 *    both, so the readers accept either.
 *
 * Everything here narrows from `unknown` and returns a fallback; nothing
 * throws. That is the same discipline `sessions/header.ts` applies to
 * persistence headers, for the same reason: these values are foreign data
 * that merely happens to be typed.
 *
 * @module @deepseek-harness-tui/dsh-tui/upstream-legacy
 */
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

/** The retired `assistant/chunk` event type, as it appears in durable logs. */
export const ASSISTANT_CHUNK_TYPE = 'assistant/chunk'

/**
 * One durable `assistant/chunk` event.
 *
 * Declared locally rather than extracted from `SessionEvent`: the union
 * dropped the member, and an `Extract` against it resolves to `never`. The
 * field set is the one upstream persisted — `{ turn, step, chunk }` — so a
 * log written by any line reads back the same way.
 */
export interface AssistantChunkEvent {
  readonly type: typeof ASSISTANT_CHUNK_TYPE
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

/**
 * One event's `type`, read through a widened view.
 *
 * A `switch` or `===` against a retired literal is a type error once the
 * union drops it, and the defensive branch is exactly for data the static
 * type no longer knows about.
 * @param event - Any session event, typed or foreign.
 * @returns Its `type` string, or an empty string when absent.
 */
export function eventType(event: unknown): string {
  if (event === null || typeof event !== 'object') return ''
  const type = (event as Record<string, unknown>)['type']
  return typeof type === 'string' ? type : ''
}

/**
 * Narrow one event to a durable `assistant/chunk`.
 *
 * Requires the fields the readers actually use, so a malformed row is
 * skipped instead of faulting mid-projection.
 * @param event - Any session event, typed or foreign.
 * @returns The chunk event, or undefined when it is not one.
 */
export function asAssistantChunk(event: unknown): AssistantChunkEvent | undefined {
  if (eventType(event) !== ASSISTANT_CHUNK_TYPE) return undefined
  const record = event as Record<string, unknown>
  const data = record['data']
  if (data === null || typeof data !== 'object') return undefined
  const payload = data as Record<string, unknown>
  const chunk = payload['chunk']
  if (
    typeof record['seq'] !== 'number' ||
    typeof payload['turn'] !== 'number' ||
    typeof payload['step'] !== 'number' ||
    chunk === null ||
    typeof chunk !== 'object'
  ) return undefined
  return {
    type: ASSISTANT_CHUNK_TYPE,
    seq: record['seq'],
    // Older rows always carried `time`; default rather than reject, since a
    // missing timestamp costs ordering polish, not correctness.
    time: typeof record['time'] === 'number' ? record['time'] : 0,
    data: {
      turn: payload['turn'],
      step: payload['step'],
      chunk: chunk as StreamChunk,
    },
  }
}

/**
 * A text-carrying delta's text, for the two chunk kinds the UI folds.
 * @param chunk - A stream chunk from a durable row.
 * @returns The delta text, or undefined for other chunk kinds.
 */
export function deltaText(chunk: StreamChunk): string | undefined {
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return undefined
  // Durable replay data may lack `text`; treat that as empty, not absent.
  return typeof chunk.text === 'string' ? chunk.text : ''
}

/**
 * The retired `EpochHeader.system` prompt text, read structurally.
 *
 * Present on older lines; absent once the system prompt became a
 * `system/message` surface event. Callers must treat `undefined` as "this
 * line reports it elsewhere", never as "there is no system prompt".
 * @param header - A request header, typed or foreign.
 * @returns The system prompt text, or undefined when the field is gone.
 */
export function legacyHeaderSystem(header: unknown): string | undefined {
  if (header === null || typeof header !== 'object') return undefined
  const system = (header as Record<string, unknown>)['system']
  return typeof system === 'string' ? system : undefined
}

/** A tool result's model-visible blocks and failure flag. */
export interface ToolResultPayload {
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

const NO_TOOL_RESULT: ToolResultPayload = Object.freeze({ content: Object.freeze([]), isError: false })

/**
 * The blocks inside a retired V3 `tool-result` wrapper block.
 *
 * Session V4 made tool results first-class `role: 'tool'` messages whose own
 * `content` is the result; V3 logs still nest it one block deeper.
 * @param block - Any content block, typed or foreign.
 * @returns The wrapped blocks, or undefined when it is not a V3 wrapper.
 */
export function legacyToolResultBlock(block: unknown): ToolResultPayload | undefined {
  if (block === null || typeof block !== 'object') return undefined
  const record = block as Record<string, unknown>
  if (record['type'] !== 'tool-result' || !Array.isArray(record['content'])) return undefined
  return { content: record['content'] as ContentBlock[], isError: record['isError'] === true }
}

/**
 * The result carried by a `tool/result` message, from either log format:
 * a V4 tool-role message, or a V3 message whose first block wraps it.
 * @param message - The event's `message`, typed or foreign.
 * @returns Its result blocks and failure flag; empty when neither shape matches.
 */
export function toolResultPayload(message: unknown): ToolResultPayload {
  if (message === null || typeof message !== 'object') return NO_TOOL_RESULT
  const record = message as Record<string, unknown>
  const content = record['content']
  if (!Array.isArray(content)) return NO_TOOL_RESULT
  if (record['role'] === 'tool') return { content: content as ContentBlock[], isError: record['isError'] === true }
  return legacyToolResultBlock(content[0]) ?? NO_TOOL_RESULT
}

/**
 * Whether a user message is a compaction checkpoint: V4 `compact-checkpoint`,
 * or the V3 `{ kind: 'plugin', plugin: 'compact' }` source it replaced.
 * @param source - A message source, typed or foreign.
 * @returns True for either checkpoint shape.
 */
export function isCompactCheckpointSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const record = source as Record<string, unknown>
  return record['kind'] === 'compact-checkpoint' || (record['kind'] === 'plugin' && record['plugin'] === 'compact')
}

/**
 * Whether a command descriptor accepts composer attachments.
 *
 * Upstream renamed `input.images` to `input.attachments` when the capability
 * broadened from images to images and files. Accept either so one build
 * works against both lines.
 * @param input - A command's input descriptor, typed or foreign.
 * @returns True when the command accepts attachments.
 */
export function acceptsAttachments(input: unknown): boolean {
  if (input === null || typeof input === 'undefined' || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  return record['attachments'] === true || record['images'] === true
}
