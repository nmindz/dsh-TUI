/**
 * Regression gate for mixed dsh-web + dsh-tui profiles.
 *
 * The installed web-app is always checked. A source checkout supplies the
 * source-authoritative prerelease baseline; CI requires it instead of silently
 * skipping it.
 * Scoped TUI host rows and preset declarations must never collide with either
 * bundle generation and must yield to every official row that generation owns.
 * Both bundles declare their patch as an ordered file list (`dsh.bundle.patch`),
 * and every file in it is part of the composition.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { prepareUpstreamSourceResolver } from './upstream-source-baseline.mjs'
// Derived from the contract so a line bump touches contract.ts only.
import { UPSTREAM_VALIDATED_VERSION } from '../lib/types/dsh-adapter/contract.js'

const yamlOptions = { logLevel: 'silent' }
const loadPatch = path => parse(readFileSync(path, 'utf8'), yamlOptions)
const insertedRows = patches => patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])
/** Every patch file a bundle manifest declares, concatenated in order. */
function bundlePatches(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : declared
  assert.ok(Array.isArray(files) && files.length > 0, `${manifestPath}: dsh.bundle.patch must name at least one file`)
  return files.flatMap(file => {
    const patches = loadPatch(join(dirname(manifestPath), file))
    assert.ok(Array.isArray(patches), `${manifestPath} ${file}: a patch must be a top-level list`)
    return patches
  })
}

const tuiManifest = fileURLToPath(new URL('../package.json', import.meta.url))
const tuiPatches = bundlePatches(tuiManifest)
const installedWebManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))
const installedWebVersion = JSON.parse(readFileSync(installedWebManifest, 'utf8')).version
const baselines = [{
  label: `installed web-app ${installedWebVersion}`,
  baseUrl: pathToFileURL(tuiManifest).href,
  webManifest: installedWebManifest,
}]

const sourceRoot = process.env.DSH_HARNESS_SOURCE_ROOT === undefined
  ? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
  : resolve(process.env.DSH_HARNESS_SOURCE_ROOT)
const sourceWebManifest = join(sourceRoot, 'packages/bundle/web-app/package.json')
const sourceBasePath = join(sourceRoot, 'packages/bundle/base/cordis.patch.yml')
const requireSourceBaseline = process.env.DSH_REQUIRE_ALPHA_BASELINE === '1'
if (existsSync(sourceWebManifest) && existsSync(sourceBasePath)) {
  const sourceWebVersion = JSON.parse(readFileSync(sourceWebManifest, 'utf8')).version
  if (requireSourceBaseline && sourceWebVersion !== UPSTREAM_VALIDATED_VERSION) {
    throw new Error(`required source baseline is ${UPSTREAM_VALIDATED_VERSION}, got ${sourceWebVersion}`)
  }
  const resolver = prepareUpstreamSourceResolver(sourceRoot)
  baselines.push({
    label: `source web-app ${sourceWebVersion}`,
    baseUrl: resolver.baseUrl,
    basePath: sourceBasePath,
    webManifest: sourceWebManifest,
  })
} else if (requireSourceBaseline) {
  throw new Error(`required source baseline missing under ${sourceRoot}`)
}

const evaluateFor = (baseline, expression, entries = []) => evaluate({
  baseUrl: baseline.baseUrl,
  loader: { entries: () => entries },
}, expression)

/** Host rows the TUI inserts under a scoped id, yielding to an official row. */
const shared = [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
  { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain' },
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
  { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry' },
  { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
  ...['standard', 'ptc', 'minimal', 'cordis'].map(preset => ({ id: `preset-${preset}`, name: '@deepseek-ai/dsh-agent-preset' })),
]

for (const baseline of baselines) {
  const basePatches = baseline.basePath === undefined ? [] : loadPatch(baseline.basePath)
  const webPatches = bundlePatches(baseline.webManifest)
  assert.ok(Array.isArray(basePatches), `${baseline.label}: base patch must be a top-level list`)

  const officialRows = insertedRows([...basePatches, ...webPatches])
  const composed = applyEntryPatches([], [...basePatches, ...webPatches, ...tuiPatches], () => {})
  const counts = new Map()
  for (const row of composed) {
    if (typeof row?.id !== 'string') continue
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id)
  assert.deepEqual(duplicates, [], `${baseline.label}: dsh-tui reuses official loader ids: ${duplicates.join(', ')}`)

  for (const { id, name } of shared) {
    const officialExpected = officialRows.some(row => row?.id === id && row?.name === name)
    const official = composed.find(row => row?.id === id && row?.name === name)
    assert.equal(Boolean(official), officialExpected, `${baseline.label}: official ${id} ownership drifted`)

    const scopedId = `dsh-tui-${id}`
    const tuiRow = composed.find(row => row?.id === scopedId && row?.name === name)
    assert.ok(tuiRow, `${baseline.label}: dsh-tui bundle must mount ${scopedId}`)
    assert.equal(typeof tuiRow.disabled, 'string', `${baseline.label}: ${scopedId} needs a !!js disabled expression`)
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled, [{ options: { id, name }, disabled: false }])), true,
      `${baseline.label}: ${scopedId} must yield to an enabled official ${id}`)
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled, [{ options: { id, name }, disabled: true }])), false,
      `${baseline.label}: ${scopedId} may serve when the official ${id} is disabled`)
    assert.equal(Boolean(evaluateFor(baseline, tuiRow.disabled)), false,
      `${baseline.label}: ${scopedId} serves a TUI-only profile`)
  }

  // Presets own the goal command in both bundles; the host row stays off.
  const tuiCommandGoal = tuiPatches.find(row => row?.id === 'command-goal')
  const webCommandGoal = webPatches.find(row => row?.id === 'command-goal')
  assert.equal(tuiCommandGoal?.disabled, true, `${baseline.label}: dsh-tui keeps the host command-goal disabled`)
  assert.equal(webCommandGoal?.disabled, true, `${baseline.label}: web-app keeps the host command-goal disabled`)

  const registryRow = composed.find(row => row?.id === 'dsh-tui-agent-preset-registry')
  assert.equal(registryRow?.config?.default, 'standard', `${baseline.label}: standard remains the default preset`)
}

console.log(`web coexistence OK (${baselines.map(({ label }) => label).join(' + ')})`)
