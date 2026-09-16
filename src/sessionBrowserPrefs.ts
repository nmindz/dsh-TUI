/**
 * The `/resume` browser's durable filter toggles, kept at
 * `~/.dsh-tui/session-browser-filters.json` so the scope a session was left in
 * is the scope the next one opens in.
 *
 * Only the three toggles are stored. The search query is deliberately not: a
 * query is how one session is found right now, and restoring it would reopen
 * the browser on a list that silently excludes nearly everything, with the
 * reason buried in a search box nobody typed into.
 *
 * Unlike the pin set this is a whole-value replacement, so there is nothing to
 * merge between two live instances and no cross-process lock to take — the
 * last writer wins, which is exactly what "my current view" means. Every
 * degradation is silent: a preference file is not worth an error banner.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_FILTERS, type BrowserFilters } from './sessions/view.js'
import { DATA_DIR } from './utils/paths.js'

const FILTERS_FILE = 'session-browser-filters.json'
let temporarySequence = 0

/** One boolean field, falling back per field rather than per file. */
function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * The persisted toggles merged over the defaults.
 *
 * @param dir - Prefs directory (injectable for tests).
 * @returns Filters with an always-empty query; defaults when unset or unreadable.
 */
export function readBrowserFilters(dir: string = DATA_DIR): BrowserFilters {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, FILTERS_FILE), 'utf8'))
  } catch {
    return DEFAULT_FILTERS
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_FILTERS
  const source = parsed as Record<string, unknown>
  return {
    query: '',
    allProjects: readBoolean(source, 'allProjects', DEFAULT_FILTERS.allProjects),
    branchOnly: readBoolean(source, 'branchOnly', DEFAULT_FILTERS.branchOnly),
    showSubagents: readBoolean(source, 'showSubagents', DEFAULT_FILTERS.showSubagents),
  }
}

/**
 * Persist the durable toggles with a private, atomic replacement.
 *
 * @param filters - Current filters; only the three toggles are written.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was replaced, false when writing failed.
 */
export function writeBrowserFilters(filters: BrowserFilters, dir: string = DATA_DIR): boolean {
  const target = join(dir, FILTERS_FILE)
  const temporary = join(
    dir,
    `${FILTERS_FILE}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`,
  )
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stored = {
      allProjects: filters.allProjects,
      branchOnly: filters.branchOnly,
      showSubagents: filters.showSubagents,
    }
    writeFileSync(temporary, JSON.stringify(stored, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, target)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The previous preference is still intact; nothing else is safe to do.
    }
    return false
  }
}
