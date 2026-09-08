/**
 * Ordered build gate list for `pnpm verify:build`.
 *
 * These used to be one 1300-character `&&` chain inside package.json. A
 * single line that long is unreviewable: any diff of it renders as one
 * enormous replacement, so an accidental drop or reorder was invisible in
 * review. One name per line makes an added or removed gate a one-line diff.
 *
 * Order is significant — the cheap static gates run first so an obvious
 * breakage fails in seconds rather than after the slow render suites.
 */
export const BUILD_GATES = [
  'verify:boundary',
  'verify:contract',
  'verify:herdr',
  'verify:manifest-deps',
  'verify:patch-surface',
  'verify:web-coexistence',
  'verify:plugin-spec',
  'verify:plugin-grants',
  'verify:plugin-storage',
  'verify:plugin-messages',
  'verify:plugin-ledger',
  'verify:plugin-commands',
  'verify:plugin-negotiation',
  'verify:plugin-lifecycle',
  'verify:runtime-themes',
  'verify:packaged-presets',
  'verify:history-search',
  'verify:initial-prompt',
  'verify:minimal-preset-tools',
  'verify:liangshen-bootstrap',
  'verify:inject-channel',
  'verify:wheel-selection',
  'verify:win32-protocol',
  'verify:selection-resize',
  'verify:liangshen-instruction-hint',
  'verify:pointer-events',
  'verify:terminal-images',
  'verify:transcript-images',
  'verify:image-preview',
  'verify:backdrop-dim',
  'verify:composer-image-tokens',
  'verify:chat-overlay',
  'verify:i18n',
  'verify:approval-visibility',
  'verify:terminal-images-sixel',
  'verify:sixel-transcript',
  'verify:migrate-sessions',
  'verify:fixed-window',
  'verify:source-hygiene',
  'verify:renderer-primitives',
  'verify:product-migration',
  'verify:spinner-identity',
  'verify:table-layout',
  'verify:btw',
  'verify:status-footer',
  'verify:turn-error-replay',
  'verify:status-segment-ledger',
]
