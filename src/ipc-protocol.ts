/**
 * IPC Protocol for NanoClaw
 * Shared constants and types for stdin/stdout multiplexed IPC.
 * Used by both the orchestrator (container-runner.ts) and agent-runner.
 */

// Stdout markers — agent output results
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Stdout markers — IPC messages relayed from agent to orchestrator
export const IPC_START_MARKER = '---NANOCLAW_IPC_START---';
export const IPC_END_MARKER = '---NANOCLAW_IPC_END---';

/** Stdin messages from orchestrator to agent (JSON lines) */
export type StdinIpcMessage =
  | { type: 'message'; text: string }
  | { type: 'close' };

/** IPC payload relayed from agent to orchestrator via stdout markers */
export interface IpcPayload {
  type: string;
  [key: string]: unknown;
}
