/**
 * Reads the plugin's live settings. The Loader hands volatile fields over as
 * references; headless harnesses still pass plain objects, so both read the
 * same way.
 * @module @deepseek-harness-tui/dsh-tui/live-settings
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { LIVE_SETTING_KEYS, type Config, type LiveSettings, type ResolvedConfig } from './index.js'

/** The settings namespace the service uses for this plugin: its Loader entry id. */
export const DEFAULT_SETTINGS_NAMESPACE = 'dsh-tui'

function current(value: unknown): unknown {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get(): unknown }).get()
    : value
}

/**
 * Snapshot the live settings as they stand now.
 * @param config - The parsed configuration (references) or a plain one.
 * @returns The defined settings, as plain values.
 */
export function readLiveSettings(config: ResolvedConfig | Config): LiveSettings {
  const source = config as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of LIVE_SETTING_KEYS) {
    const value = current(source[key])
    if (value !== undefined) out[key] = value
  }
  return out as LiveSettings
}

/**
 * The whole configuration as plain values, live settings read now.
 * @param config - The parsed configuration (references) or a plain one.
 * @returns A plain copy; later setting edits do not reach it.
 */
export function snapshotConfig(config: ResolvedConfig | Config): Config {
  const plain: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  for (const key of LIVE_SETTING_KEYS) Reflect.deleteProperty(plain, key)
  return { ...plain, ...readLiveSettings(config) } as Config
}

/**
 * This plugin's settings namespace: the settings service keys forms by the
 * Loader entry id, which a profile may rename.
 * @param ctx - The plugin context.
 * @returns The entry id, or the bundle's default row id.
 */
export function settingsNamespaceOf(ctx: Context): SettingsNamespace {
  const id = (ctx.fiber as { entry?: { options?: { id?: unknown } } } | undefined)?.entry?.options?.id
  return (typeof id === 'string' && id !== '' ? id : DEFAULT_SETTINGS_NAMESPACE) as SettingsNamespace
}

/**
 * The `dsh-tui` section of the settings.yaml the settings service renamed on
 * its one-shot import, limited to the live fields.
 * @param dshHome - The dsh home directory.
 * @returns The section, or undefined when there is none to carry.
 */
export function readRetiredSettingsSection(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')): Record<string, unknown> | undefined {
  let document: unknown
  try {
    document = parse(readFileSync(join(dshHome, 'settings.yaml.imported'), 'utf8'))
  } catch {
    return undefined
  }
  const section = document !== null && typeof document === 'object'
    ? (document as Record<string, unknown>)[DEFAULT_SETTINGS_NAMESPACE]
    : undefined
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return undefined
  const live = new Set<string>(LIVE_SETTING_KEYS)
  const carried = Object.fromEntries(Object.entries(section).filter(([key]) => live.has(key)))
  return Object.keys(carried).length === 0 ? undefined : carried
}
