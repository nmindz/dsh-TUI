#!/usr/bin/env node
/**
 * Regenerate the agent-preset declaration rows the TUI bundle ships:
 * presets/{standard,ptc,minimal,cordis}.patch.yml from the official
 * dsh-web-app declarations, and presets/liangshen.patch.yml from the
 * liangshen composition next to it.
 *
 * Harness 0.1.7 turned agent presets into `@deepseek-ai/dsh-agent-preset`
 * rows that only the web-app bundle ships, so a TUI-only profile has none.
 * The TUI ships the same declarations, re-ided `dsh-tui-preset-<id>` and
 * disabled while the official `preset-<id>` row is present: a mixed profile
 * would otherwise register each preset id twice and the registry refuses the
 * second one.
 *
 * Usage:
 *   node scripts/sync-web-presets.mjs          rewrite the copies
 *   node scripts/sync-web-presets.mjs --check  exit 1 when a copy is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const webApp = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
const webVersion = JSON.parse(readFileSync(join(webApp, 'package.json'), 'utf8')).version
export const WEB_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']
const check = process.argv.includes('--check')

/**
 * Rewrite one official declaration file into the TUI's copy.
 * @param id - Preset id (also the file stem).
 * @param source - The web-app file's text.
 * @returns The TUI copy's text.
 */
export function tuiPresetCopy(id, source) {
  const lines = source.split('\n')
  const body = lines.slice(lines.findIndex(line => !line.startsWith('#')))
  const rowId = `    - id: preset-${id}`
  const rowName = "      name: '@deepseek-ai/dsh-agent-preset'"
  const at = body.indexOf(rowId)
  if (at < 0 || body[at + 1] !== rowName) throw new Error(`dsh-web-app presets/${id}.patch.yml: unexpected declaration header`)
  body[at] = `    - id: dsh-tui-preset-${id}`
  body.splice(at + 2, 0, `      disabled: !!js "[...ctx.loader.entries()].some(entry => entry.options.id === 'preset-${id}' && entry.options.name === '@deepseek-ai/dsh-agent-preset' && !entry.disabled)"`)
  return [
    `# Agent preset ${id}, generated from @deepseek-ai/dsh-web-app@${webVersion}`,
    `# presets/${id}.patch.yml by scripts/sync-web-presets.mjs. Do not edit;`,
    '# rerun the script after bumping dsh-web-app.',
    ...body,
  ].join('\n')
}

/**
 * Wrap the liangshen composition (presets/liangshen/agent.cordis.yml plus its
 * preset.yml metadata) in a declaration row. Its local plugin modules become
 * package subpaths: a row name resolves from the installation and the profile
 * directory, never from the file that declared it.
 * @returns The presets/liangshen.patch.yml text.
 */
export function liangshenDeclaration() {
  const dir = join(root, 'presets', 'liangshen')
  const meta = Object.fromEntries(readFileSync(join(dir, 'preset.yml'), 'utf8').split('\n')
    .map(line => /^(\w+):\s*(.*)$/u.exec(line)).filter(Boolean).map(match => [match[1], match[2]]))
  const plugins = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8').trimEnd().split('\n')
    .map(line => line.replace(/^(\s*name: )\.\/([\w-]+\.mjs)$/u, "$1'@deepseek-harness-tui/dsh-tui/presets/liangshen/$2'"))
    .map(line => (line === '' ? '' : `          ${line}`))
  return [
    '# Agent preset liangshen, generated from presets/liangshen/{agent.cordis.yml,preset.yml}',
    '# by scripts/sync-web-presets.mjs. Edit those files, then rerun the script.',
    '- insert:',
    '    - id: dsh-tui-preset-liangshen',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: liangshen',
    `        name: ${meta.name}`,
    `        description: ${meta.description}`,
    `        order: ${meta.order}`,
    '        plugins:',
    ...plugins,
    '',
  ].join('\n')
}

const outputs = [
  ...WEB_PRESETS.map(id => [id, tuiPresetCopy(id, readFileSync(join(webApp, 'presets', `${id}.patch.yml`), 'utf8'))]),
  ['liangshen', liangshenDeclaration()],
]
let stale = 0
for (const [id, next] of outputs) {
  const target = join(root, 'presets', `${id}.patch.yml`)
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch {}
  if (current === next) continue
  stale += 1
  if (check) console.error(`stale: presets/${id}.patch.yml (regenerate with node scripts/sync-web-presets.mjs)`)
  else writeFileSync(target, next)
}
if (check && stale > 0) process.exit(1)
console.log(check ? `preset declarations up to date (dsh-web-app ${webVersion})` : `regenerated ${stale} preset declaration(s) (dsh-web-app ${webVersion})`)
