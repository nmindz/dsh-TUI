/**
 * Run every build gate in order, failing on the first one that fails.
 *
 * Replaces the `&&` chain that used to live in package.json's
 * `verify:build`. Same order, same fail-fast semantics, same exit code —
 * the difference is that the gate list is now reviewable line by line and
 * this runner reports which gate failed instead of leaving the reader to
 * count `&&` separators.
 *
 * Run via `npm run verify:build`.
 */
import { spawnSync } from 'node:child_process'
import { BUILD_GATES } from './build-gates.mjs'

const only = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
const gates = only.length > 0
  ? BUILD_GATES.filter(gate => only.some(name => gate === name || gate === `verify:${name}`))
  : BUILD_GATES

if (gates.length === 0) {
  console.error(`verify:build: no gate matched ${JSON.stringify(only)}`)
  process.exit(1)
}

const started = Date.now()
for (const [index, gate] of gates.entries()) {
  const label = `[${index + 1}/${gates.length}] ${gate}`
  const result = spawnSync('npm', ['run', gate], { stdio: 'inherit', shell: false })
  if (result.error !== undefined) {
    console.error(`\nverify:build: ${label} could not start: ${result.error.message}`)
    process.exit(1)
  }
  // A gate killed by a signal reports a null status; that is a failure, and
  // treating it as success would let a crashed suite pass the build.
  if (result.status !== 0) {
    const how = result.signal === null ? `exit ${result.status}` : `signal ${result.signal}`
    console.error(`\nverify:build: FAILED at ${label} (${how})`)
    process.exit(result.status === null ? 1 : result.status)
  }
}

console.log(`\nverify:build: all ${gates.length} gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
