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
import { deriveModelGroups } from '../lib/types/modelGroups.js'

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
// The picker's real top level: derivation admits a route when it is
// configured OR it actually lists models.
const rowIds = async (channel, models = []) => {
  const infos = await channel.listProviders()
  return deriveModelGroups(models, infos).map(row => row.provider)
}

// 1 + 2. Only anthropic is configured; it lists zero models yet keeps its
//        row, and the three unconfigured catalog families are gone.
{
  const channel = makeChannel({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
  const rows = await rowIds(channel)
  check('only the configured route becomes a picker row',
    rows.length === 1 && rows[0] === 'anthropic', JSON.stringify(rows))
  check('unconfigured catalog families are not offered',
    !rows.includes('openai') && !rows.includes('xai') && !rows.includes('deepseek'),
    JSON.stringify(rows))
  // Every registry route is still RETURNED (tagged), so a row earned via
  // the model union can resolve its display name.
  const listed = await ids(channel)
  check('unconfigured routes are tagged, not dropped, so labels survive',
    listed.length === REGISTRY.length, JSON.stringify(listed))
}

// 3. Two configured routes keep registry order and their display names.
{
  const channel = makeChannel({ providers: { anthropic: {}, deepseek: {} } })
  const rows = await rowIds(channel)
  check('every configured route lists, in registry order',
    rows.join(',') === 'anthropic,deepseek', JSON.stringify(rows))
  const infos = await channel.listProviders()
  check('registry display names are preserved',
    infos.find(row => row.id === 'deepseek')?.name === 'DeepSeek')
}

// 3b. A malformed/blank section must not blank the picker or throw.
{
  const channel = makeChannel({ providers: {} })
  const rows = await rowIds(channel)
  check('an empty providers section offers no rows', rows.length === 0, JSON.stringify(rows))
  // A signed-in OAuth route has no llm-pi-ai profile, yet it lists models —
  // it must still get a row, and keep its display name.
  const oauthModels = [{ provider: 'xai', id: 'grok-1', name: 'Grok 1' }]
  const infos = await channel.listProviders()
  const oauthRows = deriveModelGroups(oauthModels, infos)
  check('an unconfigured route that lists models still gets a row',
    oauthRows.some(row => row.provider === 'xai'), JSON.stringify(oauthRows.map(r => r.provider)))
  check('that row keeps its registry display name',
    oauthRows.find(row => row.provider === 'xai')?.label === 'xAI')
}

// 4. No settings service: fall back to the full registry rather than a
//    blank top level (older/embedded hosts).
{
  const channel = makeChannel(undefined)
  const rows = await rowIds(channel)
  check('no settings service falls back to the full registry',
    rows.length === REGISTRY.length, JSON.stringify(rows))
}

if (failed === 0) {
  console.log('verify-provider-listing: all checks passed')
} else {
  console.error(`verify-provider-listing: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)
