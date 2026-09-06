/**
 * Turn-error notification regression: replayed failures must stay history.
 *
 * `turn/end` with `reason.kind === 'error'` does two things — it appends a
 * transcript notice, and it pops a transient error toast. The notice is
 * history and must paint on every replay; the toast announces something
 * that just happened, so firing it during replay re-raises every failure a
 * session ever recorded.
 *
 * The reported symptom: resuming a session that had once hit a provider 529
 * popped `Turn error · {"type":"error","error":{"type":"overloaded_error",
 * "message":"Overloaded"}}` with nothing actually wrong, which reads as the
 * TUI inventing an error.
 *
 * Pins the contract:
 *   1. a turn error already in the session log replays its NOTICE but posts
 *      no notification;
 *   2. a turn error arriving LIVE still posts one (the toast is not simply
 *      deleted);
 *   3. the raw provider payload is carried verbatim into the notice, so the
 *      transcript still says exactly what the provider returned.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-turn-error-replay.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// The exact body an Anthropic 529 surfaces as `error.message`.
const OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

function makeContext() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      get() { return undefined },
      logger: { warn() {}, info() {} },
    },
  }
}

function makeAgent(events = []) {
  return {
    id: 'turn-error-agent',
    ctx: { on() { return () => {} } },
    status: 'idle',
    session: { id: 'turn-error-session', seq: events.at(-1)?.seq ?? 0, events },
    followup() {},
    steer() {},
  }
}

const options = { model: 'probe-model', cwd: '/tmp', provider: 'probe', activity: false }

const turnEndError = seq => ({
  type: 'turn/end',
  seq,
  time: 1_000 + seq,
  data: { reason: { kind: 'error', error: { message: OVERLOADED } } },
})

// 1. REPLAY: the failure is already in the log when the channel is built,
//    which is exactly what /resume does.
{
  const { ctx } = makeContext()
  const agent = makeAgent([
    { type: 'turn/start', seq: 1, time: 1_000, data: {} },
    turnEndError(2),
  ])
  const channel = createChannel(ctx, agent, options)
  check('a replayed turn error posts no notification',
    channel.notifications.length === 0,
    JSON.stringify(channel.notifications.map(n => n.text)))
  const notices = channel.rows.filter(row => row.kind === 'notice')
  check('a replayed turn error still paints its transcript notice',
    notices.some(row => row.text.startsWith('turn error')),
    JSON.stringify(notices.map(row => row.text)))
  check('the notice carries the provider payload verbatim',
    notices.some(row => row.text.includes('overloaded_error')),
    JSON.stringify(notices.map(row => row.text)))
}

// 2. LIVE: the same event arriving through the session/event handler must
//    still toast — the guard narrows replay, it does not delete the toast.
{
  const { ctx, handlers } = makeContext()
  const agent = makeAgent()
  const channel = createChannel(ctx, agent, options)
  const event = turnEndError(1)
  agent.session.seq = 1
  agent.session.events.push(event)
  handlers.get('session/event')?.(agent.session, event)
  check('a live turn error still posts a notification',
    channel.notifications.length === 1,
    JSON.stringify(channel.notifications.map(n => n.text)))
  check('the live notification is an error-colored turn failure',
    channel.notifications[0]?.color === 'error'
      && channel.notifications[0]?.text.includes('Turn error'),
    JSON.stringify(channel.notifications[0] ?? null))
}

if (failed === 0) {
  console.log('verify-turn-error-replay: all checks passed')
} else {
  console.error(`verify-turn-error-replay: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)
