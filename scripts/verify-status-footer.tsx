/**
 * Footer layout + plugin segment regression.
 *
 * Covers the two ways the status footer can be arranged: the stock path
 * (no `statusBar.layout`, per-field booleans gate, plugin segments merely
 * append) and the layout path (an explicit flat token list owns the footer,
 * `|` splits the left group from the right-aligned one, `*` expands
 * unlisted plugin segments). The backward-compat assertions are the
 * important half — `verify-display-settings` guards stock rendering, this
 * guards that nothing here changes it.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider },
  { StatusLine },
  {
    DEFAULT_STATUS_BAR,
    FOOTER_FIELD_IDS,
    FOOTER_LAYOUT_MAX,
    normalizeFooterLayout,
    normalizeStatusBar,
    sameFooterLayout,
  },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/tuiDisplayPrefs.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
function check(name: string, test: () => void): void {
  try {
    test()
    checks++
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

async function checkAsync(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    checks++
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function makeHarness(columns = 140, rows = 12) {
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })

  class FakeOutput extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }

  const stdout = new FakeOutput()
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, row) =>
      buffer.getLine(row)?.translateToString(true) ?? '',
    ).join('\n')
  }

  return { term, stdout, stderr: new FakeOutput(), stdin: new FakeStdin(), screen }
}

const baseChannel = {
  statusBar: { ...DEFAULT_STATUS_BAR },
  agentId: 'aa11bb22-cc33-4d44-8e55-66778899aabb',
  lastUsage: { input: 200_000, cacheRead: 5_000, cacheWrite: 1_000, output: 6_789 },
  contextWindow: 266_000,
  reasoningEffort: 'max',
  modeIndex: 0,
  mode: { id: 'default', plan: false },
  model: 'footer-model-probe',
  cwd: '/work/footer-project',
  displayCwd: '/work/footer-project',
  tokens: { input: 12_345, output: 6_789 },
  tps: 37,
  tpsSamples: [],
  working: false,
  gitBranch: 'feat/footer-probe',
  sessionTitle: 'footer title probe',
  workingActivity: undefined,
  activityFrames: [],
  contextBarEnabled: true,
  contextSegments: { system: 20_000, prompt: 80_000, assistant: 40_000, thinking: 30_000, tools: 36_000 },
}

let nextRegistration = 1
function segment(
  key: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    text,
    placement: 'footer-left',
    color: undefined,
    dim: false,
    order: 0,
    detail: undefined,
    tooltip: undefined,
    registrationId: nextRegistration++,
    ...extra,
  }
}

function decoration(field: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field,
    prefix: undefined,
    suffix: undefined,
    prefixByValue: undefined,
    suffixByValue: undefined,
    registrationId: nextRegistration++,
    ...extra,
  }
}

async function renderFooter(
  overrides: Record<string, unknown> = {},
  segments: readonly Record<string, unknown>[] = [],
  columns = 140,
  decorations: readonly Record<string, unknown>[] = [],
): Promise<string> {
  const harness = makeHarness(columns)
  const channel = { ...baseChannel, ...overrides }
  const instance = await render(
    <ThemeProvider theme="dark">
      <StatusLine
        channel={channel as never}
        segments={segments as never}
        decorations={decorations as never}
      />
    </ThemeProvider>,
    {
      stdout: harness.stdout as NodeJS.WriteStream,
      stderr: harness.stderr as NodeJS.WriteStream,
      stdin: harness.stdin as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  const output = harness.screen()
  await instance.unmount()
  harness.term.dispose()
  return output
}

/** Column of the first cell of `needle` on the footer's field row. */
function columnOf(screen: string, needle: string): number {
  for (const line of screen.split('\n')) {
    const at = line.indexOf(needle)
    if (at >= 0) return at
  }
  return -1
}

// ── normalizeFooterLayout: shape only ──────────────────────────────────

check('normalizeFooterLayout rejects non-arrays and empty input', () => {
  for (const value of [undefined, null, 'model', 42, {}, [], [1, 2], [{}], ['   ']]) {
    assert.equal(normalizeFooterLayout(value), undefined)
  }
})

check('normalizeFooterLayout lowercases and de-duplicates, first mention wins', () => {
  assert.deepEqual(
    [...normalizeFooterLayout(['Model', ' CWD ', 'model', 'cwd'])!],
    ['model', 'cwd'],
  )
})

check('normalizeFooterLayout keeps only the first spacer and wildcard', () => {
  assert.deepEqual([...normalizeFooterLayout(['model', '|', 'cwd', '|', 'git'])!], ['model', '|', 'cwd', 'git'])
  assert.deepEqual([...normalizeFooterLayout(['*', 'model', '*'])!], ['*', 'model'])
})

check('normalizeFooterLayout drops malformed tokens but keeps plugin keys', () => {
  assert.deepEqual(
    [...normalizeFooterLayout(['model', '/not a key/', 'my-plugin:tf', 'UPPER!'])!],
    ['model', 'my-plugin:tf'],
  )
})

check('normalizeFooterLayout caps the token count', () => {
  const many = Array.from({ length: FOOTER_LAYOUT_MAX + 8 }, (_, index) => `p${index}`)
  assert.equal(normalizeFooterLayout(many)!.length, FOOTER_LAYOUT_MAX)
})

check('a spacer-only layout is treated as unset', () => {
  assert.equal(normalizeFooterLayout(['|']), undefined)
})

check('normalizeStatusBar carries a valid layout and drops a junk one', () => {
  assert.deepEqual([...normalizeStatusBar({ layout: ['model', '|', 'cwd'] }).layout!], ['model', '|', 'cwd'])
  assert.equal(normalizeStatusBar({ layout: 'model' }).layout, undefined)
  assert.equal(normalizeStatusBar({}).layout, undefined)
})

check('sameFooterLayout compares by content, not reference', () => {
  assert.equal(sameFooterLayout(['model'], ['model']), true)
  assert.equal(sameFooterLayout(['model'], ['cwd']), false)
  assert.equal(sameFooterLayout(undefined, undefined), true)
  assert.equal(sameFooterLayout(['model'], undefined), false)
})

check('pluginSegments defaults on and every field id is addressable', () => {
  assert.equal(DEFAULT_STATUS_BAR.pluginSegments, true)
  assert.equal(DEFAULT_STATUS_BAR.layout, undefined)
  for (const id of FOOTER_FIELD_IDS) assert.equal(typeof id, 'string')
  assert.ok(!FOOTER_FIELD_IDS.includes('jobs' as never), 'jobs must not be layout-addressable')
})

// ── backward compatibility ─────────────────────────────────────────────

await checkAsync('no layout and no segments renders exactly the stock footer', async () => {
  const stock = await renderFooter()
  const withDefaults = await renderFooter({ statusBar: { ...DEFAULT_STATUS_BAR, pluginSegments: true } })
  assert.equal(withDefaults, stock)
})

await checkAsync('stock footer keeps model and cwd basename in compact mode', async () => {
  const screen = await renderFooter()
  assert.ok(screen.includes('footer-model-probe'), screen)
  assert.ok(screen.includes('footer-project'), screen)
})

// ── L1: additive plugin segments ───────────────────────────────────────

await checkAsync('a footer-left segment appends after the built-in left fields', async () => {
  const screen = await renderFooter({}, [segment('probe:tf', 'tf:prod')])
  assert.ok(screen.includes('tf:prod'), screen)
  assert.ok(columnOf(screen, 'footer-model-probe') < columnOf(screen, 'tf:prod'), screen)
})

await checkAsync('a footer-right segment renders in the right group', async () => {
  const screen = await renderFooter(
    { statusBar: { ...DEFAULT_STATUS_BAR, compact: false } },
    [segment('probe:aws', 'aws:prod', { placement: 'footer-right' })],
  )
  assert.ok(screen.includes('aws:prod'), screen)
})

await checkAsync('adding a segment does not disturb the stock field order', async () => {
  const stock = await renderFooter()
  const withSegment = await renderFooter({}, [segment('probe:tf', 'tf:prod')])
  assert.equal(columnOf(stock, 'footer-model-probe'), columnOf(withSegment, 'footer-model-probe'))
})

await checkAsync('statusBar.pluginSegments false hides segments and keeps built-ins', async () => {
  const screen = await renderFooter(
    { statusBar: { ...DEFAULT_STATUS_BAR, pluginSegments: false } },
    [segment('probe:tf', 'tf:prod')],
  )
  assert.ok(!screen.includes('tf:prod'), screen)
  assert.ok(screen.includes('footer-model-probe'), screen)
})

await checkAsync('minimal mode drops segments and ignores the layout', async () => {
  const screen = await renderFooter(
    { minimal: true, statusBar: { ...DEFAULT_STATUS_BAR, layout: ['cwd', '|', 'model'] } },
    [segment('probe:tf', 'tf:prod')],
  )
  assert.ok(!screen.includes('tf:prod'), screen)
  assert.ok(screen.includes('footer-model-probe'), screen)
})

// ── L2: explicit layout ────────────────────────────────────────────────

await checkAsync('layout membership overrides the per-field switches', async () => {
  // gitBranch/sessionId default false, yet naming them renders them; model
  // defaults true, yet omitting it hides it.
  const screen = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, layout: ['git', '|', 'sessionid'] },
  })
  assert.ok(screen.includes('feat/footer-probe'), screen)
  assert.ok(screen.includes('#aa11bb22'), screen)
  assert.ok(!screen.includes('footer-model-probe'), screen)
})

await checkAsync('the spacer splits left from the right-aligned group', async () => {
  const screen = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model', '|', 'cwd'] },
  })
  const model = columnOf(screen, 'footer-model-probe')
  const cwd = columnOf(screen, 'footer-project')
  assert.ok(model >= 0 && cwd > model, `model=${model} cwd=${cwd}\n${screen}`)
  // The right group is anchored to the margin, not merely after the left.
  assert.ok(cwd > 60, `expected a right-aligned cwd, got column ${cwd}\n${screen}`)
})

await checkAsync('a layout without a spacer puts everything in the left group', async () => {
  const screen = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model', 'cwd'] },
  })
  assert.ok(columnOf(screen, 'footer-project') < 60, screen)
})

await checkAsync('layout survives unknown tokens and data-absent fields', async () => {
  const screen = await renderFooter({
    gitBranch: undefined,
    statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model', 'nope:missing', 'git', 'cwd'] },
  })
  assert.ok(screen.includes('footer-model-probe'), screen)
  assert.ok(screen.includes('footer-project'), screen)
})

await checkAsync('layout position overrides a segment declared placement', async () => {
  const screen = await renderFooter(
    { statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model', '|', 'probe:aws'] } },
    // Declared footer-left, but named after the spacer → renders right.
    [segment('probe:aws', 'aws:prod', { placement: 'footer-left' })],
  )
  assert.ok(columnOf(screen, 'aws:prod') > columnOf(screen, 'footer-model-probe'), screen)
})

await checkAsync('the wildcard expands only segments not named explicitly', async () => {
  const screen = await renderFooter(
    { statusBar: { ...DEFAULT_STATUS_BAR, layout: ['probe:tf', 'model', '*'] } },
    [segment('probe:tf', 'tf:prod'), segment('probe:aws', 'aws:prod')],
  )
  assert.ok(screen.includes('aws:prod'), screen)
  // Named once, expanded never: exactly one occurrence of the named one.
  assert.equal(screen.split('tf:prod').length - 1, 1, screen)
})

await checkAsync('a layout renders the two-group row even when compact is on', async () => {
  // compact folds the right group into the left, so `|` would be a no-op if
  // the compact row were used; the cwd must still reach the right margin.
  const screen = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, compact: true, layout: ['model', '|', 'cwd'] },
  })
  assert.ok(columnOf(screen, 'footer-project') > 60, screen)
})

await checkAsync('compact still abbreviates the cwd under a layout', async () => {
  const compact = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, compact: true, layout: ['cwd'] },
  })
  const full = await renderFooter({
    statusBar: { ...DEFAULT_STATUS_BAR, compact: false, layout: ['cwd'] },
  })
  assert.ok(!compact.includes('/work/footer-project'), compact)
  assert.ok(full.includes('/work/footer-project'), full)
})

await checkAsync('the jobs chip survives a layout that never names it', async () => {
  const screen = await renderFooter({
    backgroundJobs: [{ id: 'j1', label: 'probe', status: 'running', startedAt: Date.now() }],
    statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model'] },
  })
  assert.ok(screen.includes('●'), screen)
})

// ── segment rendering details ──────────────────────────────────────────

await checkAsync('segment text is rendered verbatim once admitted', async () => {
  const screen = await renderFooter({}, [segment('probe:one', 'A1'), segment('probe:two', 'B2')])
  assert.ok(screen.includes('A1'), screen)
  assert.ok(screen.includes('B2'), screen)
})

await checkAsync('segments render in store order (order then registration)', async () => {
  const screen = await renderFooter({}, [
    segment('probe:first', 'FIRST'),
    segment('probe:second', 'SECOND'),
  ])
  assert.ok(columnOf(screen, 'FIRST') < columnOf(screen, 'SECOND'), screen)
})

// ── field decorations ──────────────────────────────────────────────────

await checkAsync('a static prefix decorates a built-in field', async () => {
  const screen = await renderFooter({}, [], 140, [decoration('model', { prefix: 'M> ' })])
  assert.ok(screen.includes('M> footer-model-probe'), screen)
})

await checkAsync('a suffix renders after the field', async () => {
  const screen = await renderFooter({}, [], 140, [decoration('model', { suffix: ' <M' })])
  assert.ok(screen.includes('footer-model-probe <M'), screen)
})

await checkAsync('prefixByValue selects on the field current value', async () => {
  const byValue = { max: 'MAX> ', xhigh: 'XH> ' }
  const high = await renderFooter(
    { reasoningEffort: 'xhigh' }, [], 140, [decoration('thinking', { prefixByValue: byValue })],
  )
  assert.ok(high.includes('XH> xhigh'), high)
  const max = await renderFooter(
    { reasoningEffort: 'max' }, [], 140, [decoration('thinking', { prefixByValue: byValue })],
  )
  assert.ok(max.includes('MAX> max'), max)
})

await checkAsync('a value match wins over the static prefix', async () => {
  const screen = await renderFooter(
    { reasoningEffort: 'max' }, [], 140,
    [decoration('thinking', { prefix: 'S> ', prefixByValue: { max: 'V> ' } })],
  )
  assert.ok(screen.includes('V> max'), screen)
  assert.ok(!screen.includes('S> max'), screen)
})

await checkAsync('an unmatched value falls back to the static prefix', async () => {
  const screen = await renderFooter(
    { reasoningEffort: 'low' }, [], 140,
    [decoration('thinking', { prefix: 'S> ', prefixByValue: { max: 'V> ' } })],
  )
  assert.ok(screen.includes('S> low'), screen)
})

await checkAsync('decorating does not disturb the stock field order', async () => {
  const stock = await renderFooter()
  const decorated = await renderFooter({}, [], 140, [decoration('cache', { prefix: 'C' })])
  assert.equal(columnOf(stock, 'footer-model-probe'), columnOf(decorated, 'footer-model-probe'))
})

await checkAsync('decorations apply under an explicit layout too', async () => {
  const screen = await renderFooter(
    { statusBar: { ...DEFAULT_STATUS_BAR, layout: ['model', '|', 'cwd'] } },
    [], 140, [decoration('model', { prefix: 'L> ' })],
  )
  assert.ok(screen.includes('L> footer-model-probe'), screen)
})

await checkAsync('minimal mode drops decorations', async () => {
  const screen = await renderFooter({ minimal: true }, [], 140, [decoration('model', { prefix: 'M> ' })])
  assert.ok(!screen.includes('M> '), screen)
  assert.ok(screen.includes('footer-model-probe'), screen)
})

console.log(`\nAll ${checks} status-footer checks passed.`)
