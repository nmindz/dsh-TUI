// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export {
  name,
  TuiSessionController,
  apply,
  default,
} from './dsh-adapter/session-controller.js'
export type {
  TuiSessionAgentError,
  TuiSessionAgentResult,
} from './dsh-adapter/session-controller.js'
