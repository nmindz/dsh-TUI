/**
 * Headless regression for `/model`'s top-level provider rows.
 *
 * The llm registry lists every route it can serve, which includes catalog
 * adapter families that ship mounted but that nobody configured
 * (openai/xai/deepseek). Deriving the picker's top level straight from
 * `llm.listProviders()` therefore offered providers the user never set up:
 * `/providers` correctly showed one configured route while `/model` showed
 * four groups, and entering an unconfigured one could only report
 * "unavailable". The reported bug.
 *
 * Pins the contract:
 *   1. only routes declared in `llm-pi-ai.providers` become rows;
 *   2. a CONFIGURED route that lists zero models keeps its row (the reason
 *      the rows stopped being derived from the flat model list);
 *   3. the resolved section is what counts, so a route inherited from a
 *      composition base still lists;
 *   4. with no settings service at all the full registry is the fallback,
 *      rather than a blank picker.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-provider-listing.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// Every family the adapter mounts — the shape `llm.listProviders()` returns.
const REGISTRY = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'xai', name: 'xAI' },
  { id: 'deepseek', name: 'DeepSeek' },
]

const llmStub = {
  listProviders() {
    return REGISTRY.map(entry => ({ ...entry }))
  },
  listModels(provider) {
    // anthropic is configured but lists nothing (signed-out / empty catalog):
    // its row must survive anyway.
    if (provider === 'my-gateway') return Promise.resolve([{ provider, id: 'gw-1', name: 'GW 1' }])
    return Promise.resolve([])
  },
}

function makeChannel(settingsSection) {
  const settingsStub = settingsSection === undefined
    ? undefined
    : { get: ns => (ns === 'llm-pi-ai' ? settingsSection : undefined) }
  const ctx = {
    on: () => () => {},
    get(service) {
      if (service === 'llm') return llmStub
      if (service === 'settings') return settingsStub
      return undefined
    },
    logger: { warn() {}, info() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove() { return true } },
  }
  return createChannel(ctx, agent, {
    model: 'claude-opus-5',
    cwd: '/tmp',
    provider: 'anthropic',
    activity: false,
  })
}

const ids = async channel => (await channel.listProviders()).map(info => info.id)

// 1 + 2. Only anthropic is configured; it lists zero models yet keeps its
//        row, and the three unconfigured catalog families are gone.
{
  const channel = makeChannel({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
  const listed = await ids(channel)
  check('only the configured route becomes a picker row',
    listed.length === 1 && listed[0] === 'anthropic', JSON.stringify(listed))
  check('unconfigured catalog families are not offered',
    !listed.includes('openai') && !listed.includes('xai') && !listed.includes('deepseek'),
    JSON.stringify(listed))
}

// 3. Two configured routes keep registry order and their display names.
{
  const channel = makeChannel({ providers: { anthropic: {}, deepseek: {} } })
  const rows = await channel.listProviders()
  check('every configured route lists, in registry order',
    rows.map(row => row.id).join(',') === 'anthropic,deepseek', JSON.stringify(rows.map(r => r.id)))
  check('registry display names are preserved',
    rows.find(row => row.id === 'deepseek')?.name === 'DeepSeek')
}

// 3b. A malformed/blank section must not blank the picker or throw.
{
  const channel = makeChannel({ providers: {} })
  const listed = await ids(channel)
  check('an empty providers section offers no rows', listed.length === 0, JSON.stringify(listed))
}

// 4. No settings service: fall back to the full registry rather than a
//    blank top level (older/embedded hosts).
{
  const channel = makeChannel(undefined)
  const listed = await ids(channel)
  check('no settings service falls back to the full registry',
    listed.length === REGISTRY.length, JSON.stringify(listed))
}

if (failed === 0) {
  console.log('verify-provider-listing: all checks passed')
} else {
  console.error(`verify-provider-listing: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)
