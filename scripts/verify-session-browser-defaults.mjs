#!/usr/bin/env node
/**
 * Headless regression for the /resume browser's default scope and the
 * persistence of its durable toggles.
 *
 * The defect this pins: the browser opened scoped to the live working
 * directory, so a history spread across many projects listed a handful of
 * rows and read as "my sessions are gone". The scope was one keystroke away,
 * but the keystroke reset on every open. Covered here:
 *
 *   1. the shipped default lists every working directory, with sub-agent runs
 *      still folded (they are delegated work, not conversations);
 *   2. `buildView` under that default returns rows from SEVERAL projects, and
 *      still withholds sub-agent runs and sessions holding no conversation;
 *   3. narrowing back to one project remains possible and exact;
 *   4. the three toggles round-trip through the prefs file, while the search
 *      query never persists;
 *   5. an absent or corrupt prefs file degrades to the defaults rather than
 *      throwing into a raw-mode terminal.
 *
 * Run: `node scripts/verify-session-browser-defaults.mjs`
 * Exits 1 on any failed assertion (CI gate).
 */
import fakeHome from './lib/fake-home.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildView, DEFAULT_FILTERS } from '../lib/types/sessions/view.js'
import { readBrowserFilters, writeBrowserFilters } from '../lib/types/sessionBrowserPrefs.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const prefsDir = join(fakeHome, '.dsh-tui-defaults')
mkdirSync(prefsDir, { recursive: true })

// 1. The shipped default.
check('default scope spans every working directory', DEFAULT_FILTERS.allProjects === true)
check('sub-agent runs stay folded by default', DEFAULT_FILTERS.showSubagents === false)
check('branch filter stays off by default', DEFAULT_FILTERS.branchOnly === false)
check('no query is carried by default', DEFAULT_FILTERS.query === '')

// 2/3. buildView over a two-project fixture.
const HERE = '/work/alpha'
const THERE = '/work/beta'
const session = (id, cwd, extra = {}) => ({
  id,
  kind: { kind: 'root' },
  title: { text: id, source: 'prompt' },
  cwd,
  createdAt: 1,
  updatedAt: 1,
  bytes: 10,
  hasPrompt: true,
  agentPreset: undefined,
  model: undefined,
  label: undefined,
  branch: undefined,
  childCount: 0,
  ...extra,
})

const sessions = [
  session('here-1', HERE),
  session('here-2', HERE),
  session('there-1', THERE),
  session('there-2', THERE),
  session('empty-here', HERE, { hasPrompt: false }),
  session('run-here', HERE, { kind: { kind: 'subagent', parent: 'here-1', depth: 1 } }),
]

// Exact-cwd equality is enough for this fixture and keeps the assertion about
// the filter under test rather than about path-compatibility heuristics.
const context = {
  cwd: HERE,
  branch: undefined,
  currentId: 'not-a-listed-session',
  sameProject: (a, b) => a === b,
}

const ids = view => view.rows.filter(row => row.kind === 'session').map(row => row.session.id)

const wide = buildView(sessions, DEFAULT_FILTERS, context)
const wideIds = ids(wide)
check('default view lists the current project', wideIds.includes('here-1') && wideIds.includes('here-2'))
check('default view lists OTHER projects too', wideIds.includes('there-1') && wideIds.includes('there-2'),
  wideIds.join(','))
check('default view still withholds sub-agent runs', !wideIds.includes('run-here'), wideIds.join(','))
check('default view still withholds empty sessions', !wideIds.includes('empty-here'), wideIds.join(','))
check('folded runs are counted, not lost', wide.hiddenSubagents === 1, String(wide.hiddenSubagents))
check('empty sessions are counted for cleanup', wide.emptyCount === 1, String(wide.emptyCount))
check('project headers appear once per directory',
  wide.rows.filter(row => row.kind === 'project').length === 2,
  String(wide.rows.filter(row => row.kind === 'project').length))

const narrowIds = ids(buildView(sessions, { ...DEFAULT_FILTERS, allProjects: false }, context))
check('narrowing returns to the live project only',
  narrowIds.includes('here-1') && !narrowIds.some(id => id.startsWith('there-')), narrowIds.join(','))

const runsIds = ids(buildView(sessions, { ...DEFAULT_FILTERS, showSubagents: true }, context))
check('revealing runs adds them to the wide view', runsIds.includes('run-here'), runsIds.join(','))

// 4. Round trip.
check('absent prefs file yields the defaults',
  JSON.stringify(readBrowserFilters(prefsDir)) === JSON.stringify(DEFAULT_FILTERS))

const wrote = writeBrowserFilters(
  { query: 'secret-search', allProjects: false, branchOnly: true, showSubagents: true },
  prefsDir,
)
check('toggles persist', wrote === true)
const restored = readBrowserFilters(prefsDir)
check('allProjects round-trips', restored.allProjects === false)
check('branchOnly round-trips', restored.branchOnly === true)
check('showSubagents round-trips', restored.showSubagents === true)
check('the search query is never restored', restored.query === '', JSON.stringify(restored.query))

// 5. Corruption tolerance.
writeFileSync(join(prefsDir, 'session-browser-filters.json'), '{ not json', 'utf8')
let threw = false
let afterGarbage
try {
  afterGarbage = readBrowserFilters(prefsDir)
} catch {
  threw = true
}
check('malformed prefs do not throw', threw === false)
check('malformed prefs fall back to the defaults',
  threw === false && JSON.stringify(afterGarbage) === JSON.stringify(DEFAULT_FILTERS))

writeFileSync(join(prefsDir, 'session-browser-filters.json'), '["an","array"]', 'utf8')
check('a non-object prefs file falls back to the defaults',
  JSON.stringify(readBrowserFilters(prefsDir)) === JSON.stringify(DEFAULT_FILTERS))

writeFileSync(join(prefsDir, 'session-browser-filters.json'), '{"allProjects":"yes","branchOnly":true}', 'utf8')
const mixed = readBrowserFilters(prefsDir)
check('a bad field falls back per field, keeping the good ones',
  mixed.allProjects === DEFAULT_FILTERS.allProjects && mixed.branchOnly === true,
  JSON.stringify(mixed))

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-browser default/persistence checks passed')
