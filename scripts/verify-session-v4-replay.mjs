/**
 * Session V4 transcript regression. V4 persists a tool result as a
 * `role: 'tool'` message whose own content is the result, and marks a
 * compaction checkpoint with a `compact-checkpoint` source. V3 logs nest the
 * result in a `tool-result` block and use `{ kind: 'plugin', plugin:
 * 'compact' }`. Both must replay into the same rows: a reader that only knew
 * V3 painted every V4 tool card with an empty result.
 *
 * Run after build: node scripts/verify-session-v4-replay.mjs
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { toolResultText } from '../lib/types/dsh-adapter/channel/transcript.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const ctx = { on() { return () => {} }, get() { return undefined }, logger: { warn() {}, info() {}, error() {} } }
const options = { model: 'probe-model', cwd: '/tmp', provider: 'probe', activity: false }

function replay(events) {
  const agent = {
    id: 'v4-agent',
    ctx: { on() { return () => {} } },
    status: 'idle',
    session: { id: 'v4-session', seq: events.at(-1)?.seq ?? 0, events },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, options)
}

const text = value => [{ type: 'text', text: value }]
const call = (seq, callId) => ({ type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"ls"}' } })
const v4Result = (seq, callId, body, isError) => ({
  type: 'tool/result', seq, time: seq,
  data: { turn: 1, step: 1, message: { id: `m-${callId}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: text(body), ...(isError ? { isError: true } : {}) } },
})
const v3Result = (seq, callId, body) => ({
  type: 'tool/result', seq, time: seq,
  data: { turn: 1, step: 1, message: { id: `m-${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', callId, content: text(body) }] } },
})
const turn = (seq, events) => [{ type: 'turn/start', seq, time: seq, data: {} }, ...events]

{
  const channel = replay(turn(1, [call(2, 'c4'), v4Result(3, 'c4', 'v4 listing')]))
  const card = channel.rows.find(row => row.kind === 'tool')
  check('a V4 tool-role result fills its card', card?.tool?.resultText === 'v4 listing', JSON.stringify(card?.tool?.resultText))
  check('the V4 card settles ok', card?.tool?.status === 'ok', String(card?.tool?.status))
}
{
  const channel = replay(turn(1, [call(2, 'c3'), v3Result(3, 'c3', 'v3 listing')]))
  const card = channel.rows.find(row => row.kind === 'tool')
  check('a V3 tool-result block still fills its card', card?.tool?.resultText === 'v3 listing', JSON.stringify(card?.tool?.resultText))
}
check('toolResultText reads a V4 message', toolResultText(v4Result(1, 'x', 'four')) === 'four')
check('toolResultText reads a V3 block', toolResultText(v3Result(1, 'x', 'three')) === 'three')

for (const [label, source] of [
  ['V4 compact-checkpoint', { kind: 'compact-checkpoint', compactionId: 'k1' }],
  ['V3 plugin/compact', { kind: 'plugin', plugin: 'compact' }],
]) {
  const channel = replay([{ type: 'user/message', seq: 1, time: 1, data: { id: 'u1', source, content: text('summary of earlier work') } }])
  check(`a ${label} checkpoint renders as the compact summary`,
    channel.rows.some(row => row.kind === 'compact' && row.text.includes('summary of earlier work')),
    JSON.stringify(channel.rows.map(row => row.kind)))
}

if (failed === 0) console.log('verify-session-v4-replay: all checks passed')
else console.error(`verify-session-v4-replay: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
