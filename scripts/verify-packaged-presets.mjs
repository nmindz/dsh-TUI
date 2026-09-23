/**
 * The agent-preset declarations the TUI bundle ships (presets/*.patch.yml):
 * generated copies are current, every row validates as an
 * `@deepseek-ai/dsh-agent-preset` declaration, every plugin row names a module
 * the installation can load, and the copies of official presets yield to
 * web-app's rows in mixed profiles.
 *
 * Run: node scripts/verify-packaged-presets.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const OFFICIAL = ['standard', 'ptc', 'minimal', 'cordis']
const DECLARED = [...OFFICIAL, 'liangshen']
const PACKAGE_PREFIX = '@deepseek-harness-tui/dsh-tui/'
// Row names resolve from the dsh installation first; web-app depends on every
// package its presets name, so its location stands in for the installation.
const installation = createRequire(createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh-web-app/package.json'))
const yamlTags = [{ tag: 'tag:yaml.org,2002:js', resolve: source => ({ __jsExpr: source }) }]

execFileSync(process.execPath, [join(root, 'scripts', 'sync-web-presets.mjs'), '--check'], { stdio: 'inherit' })

assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', ...DECLARED.map(id => `./presets/${id}.patch.yml`)],
  'dsh.bundle.patch lists the bundle patch, then every preset declaration')
assert.ok(manifest.files.includes('presets'), 'the presets directory ships in the package')

/** Every non-group row name of a (possibly nested) entry list. */
function rowNames(rows) {
  return rows.flatMap(row => (row.group === true ? rowNames(row.config) : [row.name]))
}

const ids = new Set()
for (const id of DECLARED) {
  const document = parse(readFileSync(join(root, 'presets', `${id}.patch.yml`), 'utf8'), { customTags: yamlTags })
  assert.equal(document.length, 1, `${id}: one insert block`)
  const [row] = document[0].insert
  assert.equal(row.id, `dsh-tui-preset-${id}`, `${id}: scoped row id`)
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset', `${id}: declaration row`)
  const config = AgentPreset.Config(row.config)
  assert.equal(config.id, id, `${id}: preset id`)
  assert.ok(!ids.has(config.id), `${id}: unique preset id`)
  ids.add(config.id)
  assert.equal(entryListProblem(config.plugins), undefined, `${id}: plugin rows validate`)
  for (const name of rowNames(config.plugins)) {
    if (name.startsWith(PACKAGE_PREFIX)) {
      const exported = name.slice(PACKAGE_PREFIX.length)
      assert.ok(existsSync(join(root, exported)), `${id}: ${name} names a shipped file`)
      assert.ok(Object.keys(manifest.exports).some(key => new RegExp(`^${key.slice(2).replace('*', '[^/]+')}$`, 'u').test(exported)), `${id}: ${name} is exported`)
      continue
    }
    assert.doesNotThrow(() => installation.resolve(name), `${id}: ${name} resolves from the installation`)
  }
  const yieldsToOfficial = typeof row.disabled === 'object' && String(row.disabled.__jsExpr).includes(`'preset-${id}'`)
  assert.equal(yieldsToOfficial, OFFICIAL.includes(id), `${id}: ${OFFICIAL.includes(id) ? 'yields to web-app\'s row' : 'has no official row to yield to'}`)
}

console.log(`preset declarations OK (${DECLARED.join(', ')})`)
