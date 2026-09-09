/**
 * Keyed status contributions above the prompt.
 *
 * `set(key, text)` remains pi's scalar `ctx.ui.setStatus` seam: the host
 * sanitizes and joins every text contribution into one line. `registerView`
 * is the bounded rich companion for compact, pointer-only surfaces that need
 * host React and themed cells (for example a progress card). It deliberately
 * receives no input, channel, or raw-terminal capability.
 *
 * Same split as the dialogs seam: a cordis-free store the chat screen
 * subscribes to, and a thin cordis service validating untrusted input.
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { capCells, cleanScalarText, flattenInline } from './sanitize.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { Theme } from '../theme.js'
import { FOOTER_FIELD_IDS } from '../tuiDisplayPrefs.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'

/** One rendered contribution. */
export interface TuiStatusEntry {
  readonly key: string
  readonly text: string
}

/** Where a status contribution renders: the line above the prompt, or a
 *  group in the status footer under it. */
export type TuiStatusPlacement = 'prompt' | 'footer-left' | 'footer-right'

/** Footer-only subset accepted by {@link TuiStatusRuntime.setSegment}. */
export type TuiFooterPlacement = Exclude<TuiStatusPlacement, 'prompt'>

/**
 * Theme tokens a footer segment may request. Restricted to an allowlist so
 * a segment retheme with the host — raw hex/ANSI is never accepted, which
 * is what keeps a plugin from painting unreadable text on a light theme.
 */
export const TUI_STATUS_COLORS = [
  'text',
  'inactive',
  'inactiveShimmer',
  'subtle',
  'suggestion',
  'remember',
  'success',
  'warning',
  'error',
  'planMode',
  'permission',
  'professionalBlue',
  'chromeYellow',
  'toolDotTask',
] as const satisfies readonly (keyof Theme)[]

export type TuiStatusColor = typeof TUI_STATUS_COLORS[number]

/** One text-only footer contribution. Structured rather than free React:
 *  the footer's width-stability and truncation contracts belong to the
 *  host, so a plugin supplies content and the host builds the cell. */
export interface TuiFooterSegment {
  /** Shares the keyed status namespace with `set`/`registerView`. */
  readonly key: string
  /** Sanitized and capped in terminal cells. */
  readonly text: string
  readonly color?: TuiStatusColor
  readonly dim?: boolean
  /** Sort weight inside its group; ties fall back to registration order. */
  readonly order?: number
  /** Supplemental-row readout while the pointer dwells on this segment. */
  readonly detail?: string
  /** Full string popped when the rendered text truncates. */
  readonly tooltip?: string
}

export type TuiFooterSegmentDisposer = () => void

/**
 * Icons for a BUILT-IN footer field. The host keeps rendering the field and
 * keeps its hover detail, truncation and width behaviour; a decoration only
 * adds text on either side, so `model` still answers a hover with
 * model/provider/context and `cache` still answers with read/write/input.
 *
 * `prefixByValue`/`suffixByValue` key off the field's current value, which
 * is how a plugin ices a field it cannot read: the effort icon has to track
 * `low`/`xhigh`/`max` at runtime and no seam exposes channel state. Keeping
 * that a lookup table rather than a callback keeps plugin code out of the
 * render path entirely. A value match wins over the static side.
 */
export interface TuiFieldDecoration {
  readonly prefix?: string
  readonly suffix?: string
  readonly prefixByValue?: Readonly<Record<string, string>>
  readonly suffixByValue?: Readonly<Record<string, string>>
}

export type TuiFieldDecorationDisposer = () => void

/** Host-side normalized decoration. Not part of the plugin shim. */
export interface TuiFieldDecorationEntry {
  readonly field: string
  readonly prefix: string | undefined
  readonly suffix: string | undefined
  readonly prefixByValue: Readonly<Record<string, string>> | undefined
  readonly suffixByValue: Readonly<Record<string, string>> | undefined
  readonly registrationId: number
}

/** Host-side normalized footer segment. Not part of the plugin shim. */
export interface TuiFooterSegmentEntry {
  readonly key: string
  readonly placement: TuiFooterPlacement
  readonly text: string
  readonly color: TuiStatusColor | undefined
  readonly dim: boolean
  readonly order: number
  readonly detail: string | undefined
  readonly tooltip: string | undefined
  readonly registrationId: number
}

/** Maximum height a rich status contribution may request. */
export type TuiStatusViewMaxRows = 1 | 2 | 3

type TuiStatusViewForbiddenBoxProps =
  | 'ref'
  | 'tabIndex'
  | 'autoFocus'
  | 'onContextMenu'
  | 'onFocus'
  | 'onFocusCapture'
  | 'onBlur'
  | 'onBlurCapture'
  | 'onKeyDown'
  | 'onKeyDownCapture'
  | 'onWheel'

type TuiStatusViewBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Box>,
  TuiStatusViewForbiddenBoxProps
>

type TuiStatusViewTextProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Text>,
  'ref'
>

type TuiStatusViewImageProps = React.ComponentProps<
  typeof import('../ui.js').Image
>

type Assert<T extends true> = T
type _TuiStatusViewBoxForbidsGlobalInput = Assert<
  Extract<TuiStatusViewForbiddenBoxProps, keyof TuiStatusViewBoxProps> extends never
    ? true
    : false
>
type _TuiStatusViewBoxKeepsPointerAndLayout = Assert<
  Exclude<
    | 'children'
    | 'flexDirection'
    | 'onClick'
    | 'onDragStart'
    | 'onDragMove'
    | 'onDragEnd'
    | 'onMouseEnter'
    | 'onMouseLeave',
    keyof TuiStatusViewBoxProps
  > extends never
    ? true
    : false
>
type _TuiStatusViewTextForbidsRef = Assert<
  'ref' extends keyof TuiStatusViewTextProps ? false : true
>

/** Pointer-only host kit passed to rich status components. `Box` keeps local
 * click, hover, and captured-drag handlers, but cannot take focus, keyboard,
 * context-menu, wheel, or ref props. Raw-terminal APIs are absent. */
export interface TuiStatusViewUi {
  readonly Box: React.ComponentType<TuiStatusViewBoxProps>
  readonly Image: React.ComponentType<TuiStatusViewImageProps>
  readonly Text: React.ComponentType<TuiStatusViewTextProps>
  readonly useTerminalSize: typeof import('../ui.js').useTerminalSize
}

/** Props for a rich status component. Hooks and elements must use the host
 * React instance, following the same single-React rule as plugin scenes. */
export interface TuiStatusViewProps {
  readonly React: typeof React
  readonly ui: TuiStatusViewUi
}

/** Cleanup handle returned for an admitted rich status registration. */
export type TuiStatusViewDisposer = () => void

/** One compact status view rendered above the prompt. Keyboard input is not
 * exposed; pointer interaction is available through `Box` click/hover/drag
 * handlers and should be paired with a slash command or separately registered
 * `tuiShortcuts` action. */
export interface TuiStatusViewDescriptor {
  readonly key: string
  /** Defaults to one row; the host clips every view at three rows. */
  readonly maxRows?: TuiStatusViewMaxRows
  readonly component: React.ComponentType<TuiStatusViewProps>
}

/** Host-side normalized registration. Kept out of the plugin export shim. */
export interface TuiStatusViewEntry {
  readonly key: string
  readonly maxRows: TuiStatusViewMaxRows
  readonly component: React.ComponentType<TuiStatusViewProps>
  /** Remounts the error boundary after a dispose + same-key re-registration. */
  readonly registrationId: number
}

// Colon-separated segments are the documented namespacing convention
// (`plugin:sub-item`); each segment stays a lowercase slug.
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/u
const TEXT_CELLS = 200
const MAX_ENTRIES = 20
const MAX_VIEW_ROWS = 3
const MAX_VIEW_ROW_BUDGET = 6
// The footer is one row shared with the built-in fields, so plugin
// segments get a hard count AND cell budget rather than flexShrink alone.
const MAX_FOOTER_SEGMENTS = 8
const FOOTER_SEGMENT_CELLS = 40
const FOOTER_SEGMENT_BUDGET = 120
const FOOTER_DETAIL_CELLS = 200
// Decorations are icons, not content: a couple of glyphs plus a space. The
// value map is bounded so a plugin cannot smuggle a catalog through it.
const DECORATION_CELLS = 8
const MAX_DECORATION_VALUES = 24
const FOOTER_PLACEMENTS: ReadonlySet<string> = new Set<TuiFooterPlacement>(['footer-left', 'footer-right'])
const STATUS_COLORS: ReadonlySet<string> = new Set<TuiStatusColor>(TUI_STATUS_COLORS)
const HOST_STATUS_OWNER = Object.freeze({ kind: 'host-status-owner' })

/** Cordis-free text + view store. Render order is first-set/register order
 * (Map insertion order), so plugin contributions do not jump on updates. */
export class TuiStatusStore {
  private readonly listeners = new Set<() => void>()
  // Each write carries a token: a disposer compares TOKENS, not text —
  // value comparison has an ABA hole (set 'x', set 'x' again, the first
  // disposer would wipe the second write, e.g. a hot reload restoring the
  // same status text).
  private readonly entries = new Map<string, { text: string; token: number; owner: object }>()
  private readonly views = new Map<string, { view: TuiStatusViewEntry; token: number; owner: object }>()
  private readonly segments = new Map<string, { segment: TuiFooterSegmentEntry; token: number; owner: object }>()
  private readonly decorations = new Map<string, { decoration: TuiFieldDecorationEntry; token: number; owner: object }>()
  // useSyncExternalStore requires a referentially stable snapshot between
  // emits — a fresh array per call would re-render in an infinite loop.
  private snapshot: readonly TuiStatusEntry[] = []
  private viewSnapshot: readonly TuiStatusViewEntry[] = []
  private segmentSnapshot: readonly TuiFooterSegmentEntry[] = []
  private decorationSnapshot: readonly TuiFieldDecorationEntry[] = []

  constructor(
    private readonly onViewError?: (key: string, error: Error) => void,
  ) {}

  /** Set or clear (undefined/empty) one key. */
  set(key: string, text: string | undefined, token = 0, owner: object = HOST_STATUS_OWNER): void {
    const had = this.entries.has(key)
    if (text === undefined || text === '') {
      if (!had) return
      this.entries.delete(key)
    } else {
      const existing = this.entries.get(key)
      if (existing?.text === text) {
        // Same text, new write: adopt the new token so the newest disposer
        // is the one that owns the line (no re-emit — nothing visible changed).
        existing.token = token
        return
      }
      this.entries.set(key, { text, token, owner })
    }
    this.snapshot = [...this.entries].map(([entryKey, entry]) => ({ key: entryKey, text: entry.text }))
    this.emit()
  }

  /** Current contributions, first-set first (stable between changes). */
  getSnapshot(): readonly TuiStatusEntry[] {
    return this.snapshot
  }

  /** Current rich contributions, first-registration first and referentially
   * stable between mutations for `useSyncExternalStore`. */
  getViewSnapshot(): readonly TuiStatusViewEntry[] {
    return this.viewSnapshot
  }

  /** Host runtime uses this to enforce that one activation cannot rewrite or
   * clear another activation's keyed contribution. */
  ownerOf(key: string): object | undefined {
    return this.entries.get(key)?.owner
  }

  viewOwnerOf(key: string): object | undefined {
    return this.views.get(key)?.owner
  }

  segmentOwnerOf(key: string): object | undefined {
    return this.segments.get(key)?.owner
  }

  /** Footer segments, sorted by declared `order` then registration order so
   *  a late re-set never makes a segment jump. Referentially stable. */
  getSegmentSnapshot(): readonly TuiFooterSegmentEntry[] {
    return this.segmentSnapshot
  }

  addSegment(segment: TuiFooterSegmentEntry, token: number, owner: object): void {
    this.segments.set(segment.key, { segment, token, owner })
    this.resnapSegments()
    this.emit()
  }

  clearSegmentIf(key: string, token: number, owner?: object): boolean {
    const current = this.segments.get(key)
    if (owner !== undefined && current?.owner !== owner) return false
    if (current?.token !== token) return false
    this.segments.delete(key)
    this.resnapSegments()
    this.emit()
    return true
  }

  /** Total cells the admitted segments occupy — the runtime checks a new
   *  registration against the aggregate budget through this. */
  segmentCells(excludeKey?: string): number {
    let total = 0
    for (const [key, entry] of this.segments) {
      if (key === excludeKey) continue
      total += stringWidth(entry.segment.text)
    }
    return total
  }

  segmentCount(excludeKey?: string): number {
    return excludeKey !== undefined && this.segments.has(excludeKey)
      ? this.segments.size - 1
      : this.segments.size
  }

  decorationOwnerOf(field: string): object | undefined {
    return this.decorations.get(field)?.owner
  }

  /** Built-in field decorations, registration order, referentially stable. */
  getDecorationSnapshot(): readonly TuiFieldDecorationEntry[] {
    return this.decorationSnapshot
  }

  addDecoration(decoration: TuiFieldDecorationEntry, token: number, owner: object): void {
    this.decorations.set(decoration.field, { decoration, token, owner })
    this.decorationSnapshot = [...this.decorations.values()].map(entry => entry.decoration)
    this.emit()
  }

  clearDecorationIf(field: string, token: number, owner?: object): boolean {
    const current = this.decorations.get(field)
    if (owner !== undefined && current?.owner !== owner) return false
    if (current?.token !== token) return false
    this.decorations.delete(field)
    this.decorationSnapshot = [...this.decorations.values()].map(entry => entry.decoration)
    this.emit()
    return true
  }

  private resnapSegments(): void {
    this.segmentSnapshot = [...this.segments.values()]
      .map(entry => entry.segment)
      .sort((a, b) => a.order - b.order || a.registrationId - b.registrationId)
  }

  addView(view: TuiStatusViewEntry, token: number, owner: object): void {
    this.views.set(view.key, { view, token, owner })
    this.viewSnapshot = [...this.views.values()].map(entry => entry.view)
    this.emit()
  }

  clearViewIf(key: string, token: number, owner?: object): boolean {
    const current = this.views.get(key)
    if (owner !== undefined && current?.owner !== owner) return false
    if (current?.token !== token) return false
    this.views.delete(key)
    this.viewSnapshot = [...this.views.values()].map(entry => entry.view)
    this.emit()
    return true
  }

  /** Called only by the host-side error boundary. */
  reportViewError(key: string, error: Error): void {
    this.onViewError?.(key, error)
  }

  /** Clear `key` only while it still holds the write tagged `token` — a
   *  stale disposer must not wipe a newer contribution (even one with
   *  identical text). Returns true when this call actually cleared. */
  clearIf(key: string, token: number, owner?: object): boolean {
    if (owner !== undefined && this.entries.get(key)?.owner !== owner) return false
    if (this.entries.get(key)?.token !== token) return false
    this.entries.delete(key)
    this.snapshot = [...this.entries].map(([entryKey, entry]) => ({ key: entryKey, text: entry.text }))
    this.emit()
    return true
  }

  /** Drop everything (teardown). */
  clear(): void {
    if (this.entries.size === 0 && this.views.size === 0 && this.segments.size === 0
      && this.decorations.size === 0) return
    this.entries.clear()
    this.views.clear()
    this.segments.clear()
    this.decorations.clear()
    this.snapshot = []
    this.viewSnapshot = []
    this.segmentSnapshot = []
    this.decorationSnapshot = []
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStatus: TuiStatusRuntime
  }
}

/**
 * `ctx.tuiStatus` — plugin-facing status contributions. Invalid keys and
 * oversized text are rejected with a logger warning instead of throwing:
 * a status contribution must never take the TUI down.
 */
export class TuiStatusRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiStatus')
    compositionRoot(ctx)
    // Keep host state out of the traceable service object. A WeakMap also
    // works with Cordis's caller-bound method proxy (unlike `#private`).
    const state: StatusState = {
      store: new TuiStatusStore((key, error) => {
        ctx.logger.warn(`dsh-tui: status view "${key}" crashed and was hidden: %o`, error)
      }),
      nextToken: 1,
      runtime: adapterRuntimeFor(ctx),
      segments: new Map(),
    }
    hostStatusStores.set(this, state)
    ctx.effect(() => () => state.store.clear())
  }

  /**
   * Set (or clear with `undefined`) the contribution for `key`. Keys are
   * plugin-namespaced by convention (`my-plugin`, `my-plugin:detail`);
   * control chars are stripped and text is capped at 200 cells. Text is
   * scalar-only: string/number/boolean are coerced to string, anything else
   * is refused with a warning (never rendered as "[object Object]", never
   * silently treated as a clear).
   *
   * Returns a disposer that clears the contribution IF the key still holds
   * exactly this write (a later set — even of identical text — wins over a
   * stale disposer). The host also removes that disposer from the caller's
   * Cordis effect list when it is invoked explicitly. Clearing with
   * `undefined` or empty text happens immediately and returns a no-op without
   * registering an owner effect.
   *
   * The optional trailing `identity` (the plugin's own ctx) only feeds the
   * effect ledger's pluginId — omitting it records `undeclared`, never a
   * guess (C-060 honest identity).
   */
  set(key: string, text: string | number | boolean | undefined, identity?: Context): () => void {
    assertCapabilityShadowPolicy('host.status.set', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
    const noop = (): void => {}
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiStatus.set', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiStatus.set requires a live non-root plugin activation')
      return noop
    }
    const state = statusStateFor(this)
    const store = state.store
    const callerIdentity = componentIdentityOf(caller)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiStatus.set')
      } catch {
        caller.logger.warn('dsh-tui: tuiStatus.set rejected an identity belonging to another activation')
        return noop
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiStatus.set requires a live activation owner')
      return noop
    }
    let normalized: string
    try {
      normalized = String(key ?? '').trim().toLowerCase()
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.set rejected an uncoercible key')
      return noop
    }
    if (!KEY_PATTERN.test(normalized)) {
      caller.logger.warn('dsh-tui: tuiStatus.set rejected an invalid key')
      return noop
    }
    if (text !== undefined && !store.getSnapshot().some(e => e.key === normalized)) {
      // New key beyond the cap: the line is one row of terminal — an
      // unbounded count would push the prompt off screen.
      if (store.getSnapshot().length >= MAX_ENTRIES) {
        caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}": ${MAX_ENTRIES} contributions already shown`)
        return noop
      }
    }
    let cleaned: string | undefined
    if (text !== undefined) {
      // Scalar-only coercion (Track A contract): a non-scalar text (an
      // object would otherwise render as "[object Object]") is REFUSED with
      // a warning — it must not silently become a clear, either.
      if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
        caller.logger.warn(`dsh-tui: tuiStatus.set rejected non-scalar text for "${normalized}"`)
        return noop
      }
      cleaned = cleanScalarText(text, TEXT_CELLS)
    }
    if (cleaned !== undefined && store.viewOwnerOf(normalized) !== undefined) {
      caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}" — the key already owns a rich view`)
      return noop
    }
    const had = store.getSnapshot().some(entry => entry.key === normalized)
    if (store.ownerOf(normalized) !== undefined && store.ownerOf(normalized) !== owner) {
      caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}" — the contribution belongs to another activation`)
      return noop
    }
    const ledger = caller.get('tuiEffectLedger')
    if (cleaned === undefined || cleaned === '') {
      store.set(normalized, undefined, 0, owner)
      if (had) ledger?.record({ operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' }, identity ?? caller)
      return noop
    }
    const token = state.nextToken++
    store.set(normalized, cleaned, token, owner)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (store.clearIf(normalized, token, owner) && ledgerApplied) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity ?? caller,
        )
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    const bound = bindCallerEffect(caller, dispose, cleanup => {
      ownerCleanup = cleanup
    })
    if (!bound) return noop
    ledger?.record(
      {
        operation: had ? 'replace' : 'bind',
        resource: { kind: 'status', id: normalized },
        result: 'applied',
        ...(had ? { replaces: { resourceId: normalized } } : {}),
      },
      identity ?? caller,
    )
    ledgerApplied = true
    return dispose
  }

  /**
   * Register a compact React view above the prompt. The component receives
   * the host's React plus a pointer-only UI kit; it owns its live data via an
   * external store and is clipped by the host to `maxRows` (one by default,
   * three at most). Registrations share the text key namespace, preserve
   * first-registration order, and consume a six-row aggregate budget.
   *
   * Successful registrations return a cleanup-aware disposer. Refused
   * registrations warn and return `undefined`, so feature-detecting callers
   * can distinguish admission from rejection. The optional identity has the
   * same attribution-only meaning as `set()`.
   */
  registerView(descriptor: TuiStatusViewDescriptor, identity?: Context): TuiStatusViewDisposer | undefined {
    assertCapabilityShadowPolicy(
      'host.status.register-view',
      statusStateFor(this).runtime.mode,
      statusStateFor(this).runtime.slices,
    )
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiStatus.registerView', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiStatus.registerView requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiStatus.registerView')
      } catch {
        caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an identity belonging to another activation')
        return undefined
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView requires a live activation owner')
      return undefined
    }
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an invalid descriptor')
      return undefined
    }
    const raw = descriptor as unknown as {
      key?: unknown
      maxRows?: unknown
      component?: unknown
    }
    let normalized: string
    try {
      normalized = String(raw.key ?? '').trim().toLowerCase()
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an uncoercible key')
      return undefined
    }
    if (!KEY_PATTERN.test(normalized)) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an invalid key')
      return undefined
    }
    const maxRows = raw.maxRows ?? 1
    if (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_VIEW_ROWS) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — maxRows must be an integer from 1 to ${MAX_VIEW_ROWS}`)
      return undefined
    }
    if (typeof raw.component !== 'function') {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — component must be a function`)
      return undefined
    }
    const state = statusStateFor(this)
    const store = state.store
    if (store.ownerOf(normalized) !== undefined || store.viewOwnerOf(normalized) !== undefined) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — the key is already registered`)
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'status', id: normalized },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity ?? caller,
      )
      return undefined
    }
    const requestedRows = store.getViewSnapshot().reduce(
      (rows, view) => rows + view.maxRows,
      maxRows,
    )
    if (requestedRows > MAX_VIEW_ROW_BUDGET) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — rich status views are limited to ${MAX_VIEW_ROW_BUDGET} rows total`)
      return undefined
    }
    const token = state.nextToken++
    const view: TuiStatusViewEntry = Object.freeze({
      key: normalized,
      maxRows: maxRows as TuiStatusViewMaxRows,
      component: raw.component as React.ComponentType<TuiStatusViewProps>,
      registrationId: token,
    })
    store.addView(view, token, owner)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (store.clearViewIf(normalized, token, owner) && ledgerApplied) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity ?? caller,
        )
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    const bound = bindCallerEffect(caller, dispose, cleanup => {
      ownerCleanup = cleanup
    })
    if (!bound) return undefined
    caller.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'status', id: normalized }, result: 'applied' },
      identity ?? caller,
    )
    ledgerApplied = true
    return dispose
  }

  /**
   * Register (or replace) one text-only footer segment. Same key namespace,
   * ownership and disposal contract as `set`; the difference is placement
   * and that the host owns the rendered cell. Refusals warn and return
   * `undefined`, so `typeof status?.setSegment === 'function'` plus an
   * `undefined` result together give a plugin a complete feature test.
   */
  setSegment(
    segment: TuiFooterSegment,
    placement: TuiFooterPlacement = 'footer-left',
    identity?: Context,
  ): TuiFooterSegmentDisposer | undefined {
    assertCapabilityShadowPolicy('host.status.set-segment', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
    return setFooterSegment(this, this.ctx, segment, placement, identity)
  }

  /**
   * Decorate a BUILT-IN footer field with icons. Unlike a segment, this does
   * not add a cell — the host still renders the field, so its hover detail,
   * truncation and width behaviour are untouched. One decoration per field,
   * owned by the registering activation.
   *
   * Refusals warn and return `undefined`, so `decorateField` is
   * feature-detectable the same way `setSegment` is.
   */
  decorateField(
    field: string,
    decoration: TuiFieldDecoration,
    identity?: Context,
  ): TuiFieldDecorationDisposer | undefined {
    assertCapabilityShadowPolicy('host.status.decorate-field', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
    return decorateFooterField(this, this.ctx, field, decoration, identity)
  }

  /**
   * Subscribe to status-line changes. Kept on the plugin-visible service so
   * the shadow-policy gate covers this subscription effect too.
   */
  subscribe(listener: () => void): () => void {
    assertCapabilityShadowPolicy('host.status.subscribe', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiStatus.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    if (typeof listener !== 'function') return () => {}
    const wrapped = () => {
      try {
        listener()
      } catch (error) {
        caller.logger.warn(`dsh-tui: tuiStatus listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const dispose = statusStateFor(this).store.subscribe(wrapped)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Sanitize one side of a decoration; '' means "not supplied". */
function cleanDecorationSide(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  // NOT cleanScalarText: that trims, and an icon's trailing space IS the
  // separator between the icon and the field ('🧠 ' + model). Trimming it
  // glued every decoration to its field. Strip control characters and cap in
  // cells, but preserve edge whitespace exactly as the plugin wrote it.
  const flat = flattenInline(String(value)).replace(/\s/gu, ' ')
  const capped = capCells(flat, DECORATION_CELLS)
  return capped === '' ? '' : capped
}

/** Sanitize a value→icon lookup table; undefined when unusable. */
function cleanDecorationMap(value: unknown, reject: () => void): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject()
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_DECORATION_VALUES) {
    reject()
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    const cleaned = cleanDecorationSide(raw)
    if (cleaned === undefined || cleaned === '') continue
    out[key] = cleaned
  }
  return Object.keys(out).length === 0 ? undefined : Object.freeze(out)
}

/** Implementation of {@link TuiStatusRuntime.decorateField}. */
function decorateFooterField(
  runtime: TuiStatusRuntime,
  ctx: Context,
  field: string,
  decoration: TuiFieldDecoration,
  identity?: Context,
): TuiFieldDecorationDisposer | undefined {
  let caller: Context
  try {
    caller = requirePluginCaller(ctx, 'tuiStatus.decorateField', runtime)
  } catch {
    ctx.logger.warn('dsh-tui: tuiStatus.decorateField requires a live non-root plugin activation')
    return undefined
  }
  if (identity !== undefined) {
    try {
      assertCallerContext(caller, identity, 'tuiStatus.decorateField')
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.decorateField rejected an identity belonging to another activation')
      return undefined
    }
  }
  const owner = activationFiber(caller)
  if (owner === undefined) {
    caller.logger.warn('dsh-tui: tuiStatus.decorateField requires a live activation owner')
    return undefined
  }
  let normalized: string
  try {
    normalized = String(field ?? '').trim()
  } catch {
    caller.logger.warn('dsh-tui: tuiStatus.decorateField rejected an uncoercible field')
    return undefined
  }
  // Only built-in field slots may be decorated; a plugin segment already
  // owns its own text, and `jobs` is deliberately not addressable.
  const target = FOOTER_FIELD_IDS.find(id => id.toLowerCase() === normalized.toLowerCase())
  if (target === undefined) {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected "${normalized}" — not a built-in footer field`)
    return undefined
  }
  if (typeof decoration !== 'object' || decoration === null || Array.isArray(decoration)) {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected an invalid decoration for "${target}"`)
    return undefined
  }
  const raw = decoration as unknown as Record<string, unknown>
  const prefix = cleanDecorationSide(raw.prefix)
  const suffix = cleanDecorationSide(raw.suffix)
  if (prefix === '' || suffix === '') {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected non-scalar icon text for "${target}"`)
    return undefined
  }
  let mapRejected = false
  const reject = (): void => { mapRejected = true }
  const prefixByValue = cleanDecorationMap(raw.prefixByValue, reject)
  const suffixByValue = cleanDecorationMap(raw.suffixByValue, reject)
  if (mapRejected) {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected an invalid value map for "${target}"`)
    return undefined
  }
  if (prefix === undefined && suffix === undefined
    && prefixByValue === undefined && suffixByValue === undefined) {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected an empty decoration for "${target}"`)
    return undefined
  }
  const state = statusStateFor(runtime)
  const store = state.store
  const existingOwner = store.decorationOwnerOf(target)
  if (existingOwner !== undefined && existingOwner !== owner) {
    caller.logger.warn(`dsh-tui: tuiStatus.decorateField rejected "${target}" — the field is decorated by another activation`)
    caller.get('tuiEffectLedger')?.record(
      {
        operation: 'bind',
        resource: { kind: 'status', id: `decoration:${target}` },
        result: 'failed',
        errorCode: 'DUPLICATE_CONTRIBUTION_ID',
      },
      identity ?? caller,
    )
    return undefined
  }
  const had = existingOwner !== undefined
  const token = state.nextToken++
  store.addDecoration(
    Object.freeze({
      field: target,
      prefix,
      suffix,
      prefixByValue,
      suffixByValue,
      registrationId: token,
    }),
    token,
    owner,
  )
  let disposed = false
  let ledgerApplied = false
  let ownerCleanup: (() => unknown) | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (store.clearDecorationIf(target, token, owner) && ledgerApplied) {
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'status', id: `decoration:${target}` }, result: 'applied' },
        identity ?? caller,
      )
    }
    const cleanup = ownerCleanup
    ownerCleanup = undefined
    cleanup?.()
  }
  const bound = bindCallerEffect(caller, dispose, cleanup => {
    ownerCleanup = cleanup
  })
  if (!bound) return undefined
  caller.get('tuiEffectLedger')?.record(
    {
      operation: had ? 'replace' : 'bind',
      resource: { kind: 'status', id: `decoration:${target}` },
      result: 'applied',
      ...(had ? { replaces: { resourceId: `decoration:${target}` } } : {}),
    },
    identity ?? caller,
  )
  ledgerApplied = true
  return dispose
}

/** Implementation of {@link TuiStatusRuntime.setSegment}; kept at module
 *  scope so the class body stays readable. */
function setFooterSegment(
  runtime: TuiStatusRuntime,
  ctx: Context,
  segment: TuiFooterSegment,
  placement: TuiFooterPlacement,
  identity?: Context,
): TuiFooterSegmentDisposer | undefined {
  let caller: Context
  try {
    caller = requirePluginCaller(ctx, 'tuiStatus.setSegment', runtime)
  } catch {
    ctx.logger.warn('dsh-tui: tuiStatus.setSegment requires a live non-root plugin activation')
    return undefined
  }
  if (identity !== undefined) {
    try {
      assertCallerContext(caller, identity, 'tuiStatus.setSegment')
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.setSegment rejected an identity belonging to another activation')
      return undefined
    }
  }
  const owner = activationFiber(caller)
  if (owner === undefined) {
    caller.logger.warn('dsh-tui: tuiStatus.setSegment requires a live activation owner')
    return undefined
  }
  if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) {
    caller.logger.warn('dsh-tui: tuiStatus.setSegment rejected an invalid segment')
    return undefined
  }
  if (!FOOTER_PLACEMENTS.has(placement)) {
    caller.logger.warn('dsh-tui: tuiStatus.setSegment rejected an unknown placement')
    return undefined
  }
  const raw = segment as unknown as Record<string, unknown>
  let normalized: string
  try {
    normalized = String(raw.key ?? '').trim().toLowerCase()
  } catch {
    caller.logger.warn('dsh-tui: tuiStatus.setSegment rejected an uncoercible key')
    return undefined
  }
  if (!KEY_PATTERN.test(normalized)) {
    caller.logger.warn('dsh-tui: tuiStatus.setSegment rejected an invalid key')
    return undefined
  }
  // Scalar-only, same contract as set(): a non-scalar must be refused
  // rather than silently rendering "[object Object]".
  if (typeof raw.text !== 'string' && typeof raw.text !== 'number' && typeof raw.text !== 'boolean') {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected non-scalar text for "${normalized}"`)
    return undefined
  }
  const text = cleanScalarText(raw.text, FOOTER_SEGMENT_CELLS)
  if (text === '') {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected empty text for "${normalized}"`)
    return undefined
  }
  if (raw.color !== undefined && (typeof raw.color !== 'string' || !STATUS_COLORS.has(raw.color))) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected an unsupported color for "${normalized}"`)
    return undefined
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected a non-finite order for "${normalized}"`)
    return undefined
  }
  const state = statusStateFor(runtime)
  const store = state.store
  // One key, one surface: a key already carrying text or a rich view must
  // not also become a footer segment.
  if (store.ownerOf(normalized) !== undefined || store.viewOwnerOf(normalized) !== undefined) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected "${normalized}" — the key is already registered`)
    caller.get('tuiEffectLedger')?.record(
      {
        operation: 'bind',
        resource: { kind: 'status', id: normalized },
        result: 'failed',
        errorCode: 'DUPLICATE_CONTRIBUTION_ID',
      },
      identity ?? caller,
    )
    return undefined
  }
  const existingOwner = store.segmentOwnerOf(normalized)
  if (existingOwner !== undefined && existingOwner !== owner) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected "${normalized}" — the segment belongs to another activation`)
    return undefined
  }
  const had = existingOwner !== undefined
  // Budgets are computed excluding this key so a replace is never charged
  // twice for the segment it is replacing.
  if (store.segmentCount(normalized) >= MAX_FOOTER_SEGMENTS) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected "${normalized}": ${MAX_FOOTER_SEGMENTS} footer segments already shown`)
    return undefined
  }
  if (store.segmentCells(normalized) + stringWidth(text) > FOOTER_SEGMENT_BUDGET) {
    caller.logger.warn(`dsh-tui: tuiStatus.setSegment rejected "${normalized}": footer segments are limited to ${FOOTER_SEGMENT_BUDGET} cells`)
    return undefined
  }
  const detail = raw.detail === undefined ? undefined : cleanScalarText(raw.detail, FOOTER_DETAIL_CELLS)
  const tooltip = raw.tooltip === undefined ? undefined : cleanScalarText(raw.tooltip, FOOTER_DETAIL_CELLS)
  // A refresh that produces byte-identical content is not a state change.
  // Plugins poll on a timer, so without this every tick wrote a ledger pair
  // and re-emitted the store; git/node segments alone reached ~90k records.
  const signature = JSON.stringify([
    placement, text, raw.color ?? null, raw.dim === true,
    typeof raw.order === 'number' ? raw.order : 0,
    detail === '' ? null : detail ?? null, tooltip === '' ? null : tooltip ?? null,
  ])
  const live = state.segments.get(normalized)
  if (live !== undefined && live.owner === owner && live.signature === signature
    && store.segmentOwnerOf(normalized) !== undefined) {
    return live.dispose
  }
  // Replacing this key: retire the old binding so a long-lived plugin does
  // not accumulate one caller effect per content change.
  if (live !== undefined && live.owner === owner) live.retire()

  const token = state.nextToken++
  store.addSegment(
    Object.freeze({
      key: normalized,
      placement,
      text,
      color: raw.color as TuiStatusColor | undefined,
      dim: raw.dim === true,
      order: typeof raw.order === 'number' ? raw.order : 0,
      detail: detail === '' ? undefined : detail,
      tooltip: tooltip === '' ? undefined : tooltip,
      registrationId: token,
    }),
    token,
    owner,
  )
  let disposed = false
  let ledgerApplied = false
  let silent = false
  let ownerCleanup: (() => unknown) | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (state.segments.get(normalized)?.dispose === dispose) state.segments.delete(normalized)
    if (store.clearSegmentIf(normalized, token, owner) && ledgerApplied && !silent) {
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
        identity ?? caller,
      )
    }
    const cleanup = ownerCleanup
    ownerCleanup = undefined
    cleanup?.()
  }
  const bound = bindCallerEffect(caller, dispose, cleanup => {
    ownerCleanup = cleanup
  })
  if (!bound) return undefined
  state.segments.set(normalized, {
    owner,
    signature,
    dispose,
    retire: () => { silent = true; dispose() },
  })
  caller.get('tuiEffectLedger')?.record(
    {
      operation: had ? 'replace' : 'bind',
      resource: { kind: 'status', id: normalized },
      result: 'applied',
      ...(had ? { replaces: { resourceId: normalized } } : {}),
    },
    identity ?? caller,
  )
  ledgerApplied = true
  return dispose

}

/** Host-only status store accessor; not part of the package export map. */
interface StatusState {
  readonly store: TuiStatusStore
  nextToken: number
  readonly runtime: AdapterRuntimeOptions
  /** Live footer registrations, so an unchanged re-set is a no-op. */
  readonly segments: Map<string, SegmentRegistration>
}

/** What a key currently holds, for the idempotence check in setSegment. */
interface SegmentRegistration {
  readonly owner: object
  readonly signature: string
  readonly dispose: () => void
  /** Drop the previous effect binding on replace, writing no ledger record:
   *  a replace already reports that the prior binding ended. */
  readonly retire: () => void
}

const hostStatusStores = new WeakMap<TuiStatusRuntime, StatusState>()

function statusStateFor(runtime: TuiStatusRuntime): StatusState {
  const store = hostStatusStores.get(concreteService(runtime))
  if (store === undefined) throw new Error('tuiStatus host store is unavailable')
  return store
}

export function getHostStatusStore(runtime: TuiStatusRuntime | undefined): TuiStatusStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostStatusStores.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

export default TuiStatusRuntime
