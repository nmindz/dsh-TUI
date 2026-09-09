/**
 * Pure derivation for the two-level `/model` picker: providers as top-level
 * groups, their models one level down, with a pinned "recently used"
 * pseudo-group first. Kept free of React/channel/i18n state so
 * `scripts/verify-model-picker-groups.mjs` can drive it headless; the
 * recents row's localized label is resolved at render time (its `label`
 * field is the {@link RECENTS_LABEL_PLACEHOLDER} sentinel).
 *
 * @module dsh-tui/modelGroups
 */

import type { LlmModelInfo } from './adapter/ports/channel-view.js'
import type { ModelProviderInfo } from './dsh-adapter/types.js'

/**
 * The pseudo provider key of the pinned "recently used" group. Provider
 * route ids cannot contain underscores (`PROVIDER_ROUTE_ID`), so this can
 * never collide with a real route.
 */
export const RECENTS_GROUP_PROVIDER = '__recents__'

/** The recents row's raw label; renderers replace it with the localized one. */
export const RECENTS_LABEL_PLACEHOLDER = '__recent__'

/** One recent-model reference (same shape as modelRecents' persisted ref). */
export interface ModelRef {
  readonly provider: string
  readonly id: string
}

/** One top-level row: a provider route with its picker-facing identity. */
export interface ModelGroupRow {
  /** Harness route key (also the grouping key over `LlmModelInfo.provider`). */
  readonly provider: string
  /** Display label — the registry's provider name, falling back to the route key. */
  readonly label: string
  /** How many of the listed models belong to this provider; 0 = registered
   *  but listing nothing (signed-out OAuth route, empty configured catalog,
   *  or a listing that failed), which the picker renders as unavailable. */
  readonly count: number
}

/**
 * The route keys the picker's top level covers, in registry order.
 *
 * Registered routes come first, in `listProviders()` order — the order
 * `Channel.listModels()` flattens its per-route lists in — so a route that
 * lists **no** models still gets a row. Deriving the top level from the model
 * list alone made such a route vanish from `/model` with nothing to say why.
 * Any provider seen only in `models` is appended, so a catalog richer than
 * the directory is never truncated.
 */
function routeOrder(
  models: readonly LlmModelInfo[],
  providerInfos: readonly ModelProviderInfo[],
): string[] {
  const order: string[] = []
  const serves = new Set(models.map(model => model.provider))
  for (const info of providerInfos) {
    // `configured === false` marks a route the registry serves but no
    // profile declares — an unconfigured catalog family, or an OAuth route
    // claimed while signed out. It earns a row only by actually listing
    // models; otherwise entering it could say nothing but "unavailable".
    // Undefined means the host does not tag, which stays configured.
    if (info.configured === false && !serves.has(info.id)) continue
    if (!order.includes(info.id)) order.push(info.id)
  }
  for (const model of models) {
    if (!order.includes(model.provider)) order.push(model.provider)
  }
  return order
}

/**
 * The recent refs that the current catalog still lists, most-recent-first —
 * the second level of the recents group. Refs whose model vanished from the
 * catalog (provider removed, or an OAuth provider signed out and
 * credential-gated away) drop out here, so the group never offers a row the
 * picker could not switch to.
 */
export function recentCatalogModels(
  recents: readonly ModelRef[],
  models: readonly LlmModelInfo[],
): readonly LlmModelInfo[] {
  const listed: LlmModelInfo[] = []
  for (const ref of recents) {
    const found = models.find(model => model.provider === ref.provider && model.id === ref.id)
    if (found === undefined) continue
    if (listed.some(seen => seen.provider === found.provider && seen.id === found.id)) continue
    listed.push(found)
    if (listed.length >= 10) break
  }
  return listed
}

/**
 * Group a flat model catalog into provider rows in registry order, labels
 * resolved through `providerInfos` with a route-key fallback. Every route in
 * `providerInfos` gets a row even when it lists nothing (`count === 0`).
 * Recent refs (when supplied and still catalogued) pin one extra pseudo-group
 * at the top.
 */
export function deriveModelGroups(
  models: readonly LlmModelInfo[],
  providerInfos: readonly ModelProviderInfo[],
  recents?: readonly ModelRef[],
): readonly ModelGroupRow[] {
  const counts = new Map<string, number>()
  for (const model of models) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1)
  }
  const groups: ModelGroupRow[] = routeOrder(models, providerInfos).map(provider => ({
    provider,
    label: providerInfos.find(info => info.id === provider)?.name ?? provider,
    count: counts.get(provider) ?? 0,
  }))
  if (recents !== undefined) {
    const recentCount = recentCatalogModels(recents, models).length
    if (recentCount > 0) {
      groups.unshift({ provider: RECENTS_GROUP_PROVIDER, label: RECENTS_LABEL_PLACEHOLDER, count: recentCount })
    }
  }
  return groups
}

/** Where `/model` should open (or re-land after the fresh catalog arrives). */
export interface ModelPickerLanding {
  /**
   * The group to open *inside* — set only by the single-provider fast path,
   * where a one-row top level would be pure friction (and there are no
   * recents to pin). Multi-provider catalogs — and any catalog with recents
   * — land at the top level (`undefined`).
   */
  readonly group: string | undefined
  /** Focus index within the landed level's rows. */
  readonly index: number
}

/**
 * Compute the picker's landing: with a meaningful recents list pinned, focus
 * the recents row itself (its first entry is the most recently used model —
 * the likeliest destination); without recents, focus the current provider's
 * group. The single-provider fast path applies while recents carry no
 * navigation value — an empty list, or a lone entry that can only be the
 * current model (the picker seeds it): drilling straight into the only
 * provider's list beats a top level whose recents row duplicates it. Two or
 * more recents (or any multi-provider catalog) land at the top level.
 *
 * @param providerInfos - the registered routes, so the landing counts the same
 *   rows {@link deriveModelGroups} renders. Omitted (or empty) it falls back to
 *   the routes the models themselves name — which is what the second-level
 *   callers want, since they pass one group's models to get an index inside it.
 */
export function modelPickerLanding(
  models: readonly LlmModelInfo[],
  currentProvider: string | undefined,
  currentModel: string | undefined,
  recents?: readonly ModelRef[],
  providerInfos?: readonly ModelProviderInfo[],
): ModelPickerLanding {
  const providers = routeOrder(models, providerInfos ?? [])
  if (providers.length === 0) return { group: undefined, index: 0 }
  const recentCount = recents === undefined ? 0 : recentCatalogModels(recents, models).length
  if (providers.length === 1 && recentCount <= 1) {
    const only = providers[0]!
    const index = models.findIndex(
      model => model.provider === currentProvider && model.id === currentModel,
    )
    return { group: only, index: index >= 0 ? index : 0 }
  }
  if (recentCount > 0) return { group: undefined, index: 0 }
  const groupIndex = providers.indexOf(currentProvider ?? '')
  return { group: undefined, index: groupIndex >= 0 ? groupIndex : 0 }
}
