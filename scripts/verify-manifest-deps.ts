/**
 * CI gate for the #198 dependency-classification contract: framework packages
 * (`@deepseek-ai/*`) are host-provided and must never ship as runtime
 * dependencies — a real copy inside a profile shadows the host instance and
 * splits module identity (the TOOL_RUNTIME_SCHEDULER crash). This gate fails
 * the build when the manifest drifts back:
 *
 *   1. neither `dependencies` nor `optionalDependencies` contains an
 *      `@deepseek-ai/*` package (an optional install would still land a real
 *      copy in the profile whenever pnpm can resolve it);
 *   2. every `@deepseek-ai/*` peerDependency is also a devDependency (local
 *      type-check). The two ranges deliberately differ: the peer range is the
 *      host-admission policy and is permissive, the dev range pins the line
 *      this repo builds and resolves against. Every `dsh-*` peer must carry
 *      the SAME permissive range, so one package cannot quietly narrow it;
 *   3. every `@deepseek-ai/*` peerDependency is optional, so npm consumers do
 *      not auto-install a second framework tree beside the dsh host;
 *   4. the `@deepseek-ai/*` peer set equals UPSTREAM_BLESSED_PACKAGES, so an
 *      ungated peer (or a blessed package dropped from the manifest) fails
 *      here instead of drifting silently.
 *
 * Run via `node --import tsx/esm scripts/verify-manifest-deps.ts`.
 */
import { readFileSync } from 'node:fs'

const { UPSTREAM_BLESSED_PACKAGES } = await import('../src/dsh-adapter/contract.js')

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const FRAMEWORK = /^@deepseek-ai\//
const failures: string[] = []

for (const section of ['dependencies', 'optionalDependencies'] as const) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (FRAMEWORK.test(name)) {
      failures.push(`${name} is in ${section} — framework packages must be peer + dev only (#198)`)
    }
  }
}

/** Host-admission policy for the harness line. dsh checks peer ranges with
 *  `includePrerelease`, so one open comparator admits every prerelease line —
 *  including ones published after this build. Drift is reported at boot and by
 *  `verify:contract`, not by refusing to load. */
const HARNESS_PEER_RANGE = '>=0.1.0-rc.6'
const HARNESS = /^@deepseek-ai\/dsh-/

const peers: string[] = Object.keys(manifest.peerDependencies ?? {}).filter((name) => FRAMEWORK.test(name))
for (const name of peers) {
  const peerRange = manifest.peerDependencies[name]
  const devRange = manifest.devDependencies?.[name]
  if (devRange === undefined) {
    failures.push(`${name} is a peerDependency without a matching devDependency (local type-check would break)`)
  }
  if (HARNESS.test(name) && peerRange !== HARNESS_PEER_RANGE) {
    failures.push(`${name} peer range is "${peerRange}", not the shared "${HARNESS_PEER_RANGE}" — a narrowed peer refuses hosts the rest of the manifest admits`)
  }
  if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
    failures.push(`${name} is a host-provided peer but is not marked optional (npm would auto-install a second framework tree)`)
  }
}

const blessed = [...UPSTREAM_BLESSED_PACKAGES] as string[]
for (const name of peers.filter((name) => !blessed.includes(name))) {
  failures.push(`${name} is a peer but missing from UPSTREAM_BLESSED_PACKAGES (src/dsh-adapter/contract.ts) — the upstream-contract gate would not catch its drift`)
}
for (const name of blessed.filter((name) => !peers.includes(name))) {
  failures.push(`${name} is in UPSTREAM_BLESSED_PACKAGES but not a peerDependency`)
}

if (failures.length > 0) {
  console.error('Manifest dependency classification violated:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`manifest deps OK (${peers.length} optional framework peers, all mirrored in dev, dsh-* peers at "${HARNESS_PEER_RANGE}", blessed list in sync)`)
