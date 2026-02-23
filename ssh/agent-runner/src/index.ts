/**
 * NanoClaw SSH Agent Runner
 * Runs on a Pi via SSH, receives config via stdin lines, outputs result to stdout
 *
 * Input protocol (stdio mode):
 *   Stdin line 1: Full ContainerInput JSON
 *   Stdin lines 2+: JSON lines — {"type":"message","text":"..."} or {"type":"close"}
 *   Agent→Host IPC relayed as stdout markers (IPC_START/END) instead of files
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   IPC messages are also emitted as IPC_START_MARKER / IPC_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  ipcMode?: 'stdio';        // Always 'stdio' for SSH runner
  groupWorkDir?: string;     // Working directory (default: /workspace/group)
  ipcDir?: string;           // IPC directory (default: /workspace/ipc)
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// --- Marker constants (must match orchestrator) ---

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_START_MARKER = '---NANOCLAW_IPC_START---';
const IPC_END_MARKER = '---NANOCLAW_IPC_END---';

// --- Configurable paths (set from ContainerInput in main()) ---

let IPC_DIR = '/workspace/ipc';
let GROUP_WORK_DIR = '/workspace/group';
const IPC_POLL_MS = 500;

// --- Stdin reading (line-based for SSH/stdio mode) ---

/**
 * Read the first JSON line from stdin.
 * Returns the parsed JSON and leaves stdin open for subsequent lines.
 * Falls back to reading until EOF if no newline arrives (backward compat).
 */
async function readInitialInput(): Promise<ContainerInput> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');

    const onData = (chunk: string) => {
      buffer += chunk;
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', onEnd);
        process.stdin.removeListener('error', onError);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    const onEnd = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error('stdin closed with no data'));
      }
    };

    const onError = (err: Error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      reject(err);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

/**
 * Reads JSON lines from stdin after the initial input.
 * Buffers lines and provides pull-based access for the query loop.
 */
class StdinIpcReader {
  private lineQueue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;

  start(): void {
    let buffer = '';
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this.onLine(line);
      }
    });
    process.stdin.on('end', () => {
      this.closed = true;
      this.waiting?.(null);
    });
  }

  private onLine(line: string) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(line);
    } else {
      this.lineQueue.push(line);
    }
  }

  /** Read the next stdin JSON line. Returns null if stdin closed. */
  async readLine(): Promise<string | null> {
    if (this.lineQueue.length > 0) return this.lineQueue.shift()!;
    if (this.closed) return null;
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  /** Drain all buffered lines. */
  drainLines(): string[] {
    const lines = [...this.lineQueue];
    this.lineQueue.length = 0;
    return lines;
  }
}

// --- Output functions ---

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function writeIpc(payload: object): void {
  console.log(IPC_START_MARKER);
  console.log(JSON.stringify(payload));
  console.log(IPC_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// --- IPC relay: poll local IPC files and emit as stdout markers ---

let ipcRelayRunning = false;

/**
 * Start relaying IPC files (written by MCP server) as stdout markers.
 * The host can't read the agent's local filesystem over SSH,
 * so we poll the IPC directories and relay their contents through stdout.
 */
function startIpcRelay(): void {
  if (ipcRelayRunning) return;
  ipcRelayRunning = true;

  const messagesDir = path.join(IPC_DIR, 'messages');
  const tasksDir = path.join(IPC_DIR, 'tasks');

  const relayDir = (dir: string) => {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          writeIpc(data);
          fs.unlinkSync(filePath);
        } catch (err) {
          log(`IPC relay error for ${file}: ${err instanceof Error ? err.message : String(err)}`);
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }
    } catch { /* dir might not exist yet */ }
  };

  const poll = () => {
    if (!ipcRelayRunning) return;
    relayDir(messagesDir);
    relayDir(tasksDir);
    setTimeout(poll, IPC_POLL_MS);
  };

  poll();
}

function stopIpcRelay(): void {
  ipcRelayRunning = false;
}

// --- Stdin-based IPC ---

/**
 * Wait for a new message or close signal via stdin.
 * Returns the message text, or null if close.
 */
async function waitForStdinMessage(reader: StdinIpcReader): Promise<string | null> {
  const messages: string[] = [];

  // First drain any buffered lines
  for (const line of reader.drainLines()) {
    try {
      const data = JSON.parse(line);
      if (data.type === 'close') return null;
      if (data.type === 'message' && data.text) messages.push(data.text);
    } catch (err) {
      log(`Failed to parse stdin IPC line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (messages.length > 0) return messages.join('\n');

  // Wait for the next line
  while (true) {
    const line = await reader.readLine();
    if (line === null) return null; // stdin closed

    try {
      const data = JSON.parse(line);
      if (data.type === 'close') return null;
      if (data.type === 'message' && data.text) return data.text;
    } catch (err) {
      log(`Failed to parse stdin IPC line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// --- Query execution ---

/**
 * Run a single query by spawning `claude -p` as a child process.
 * Each conversational turn is a separate CLI invocation.
 * Multi-turn works via `--resume <sessionId>`.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpConfigPath: string,
  globalClaudeMd: string | undefined,
  extraDirs: string[],
): Promise<{ sessionId?: string; result: string | null; error?: string }> {

  const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'json'];

  // Session resumption
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // MCP config
  args.push('--mcp-config', mcpConfigPath);

  // Allowed tools
  const allowedTools = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
  args.push('--allowedTools', allowedTools.join(','));

  // Additional directories
  for (const dir of extraDirs) {
    args.push('--add-dir', dir);
  }

  // Global CLAUDE.md for non-main groups
  if (globalClaudeMd) {
    args.push('--append-system-prompt', globalClaudeMd);
  }

  // Settings sources
  args.push('--setting-sources', 'project,user');

  log(`Spawning: claude ${args.slice(0, 6).join(' ')}... (${args.length} args)`);

  const proc = spawn('claude', args, {
    cwd: GROUP_WORK_DIR,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write prompt to stdin, then close
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Collect stdout (JSON result) and stderr (debug info)
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => stdout += d);
  proc.stderr.on('data', (d: Buffer) => stderr += d);

  return new Promise((resolve) => {
    proc.on('close', (code) => {
      if (code !== 0) {
        log(`Claude exited with code ${code}: ${stderr.slice(-500)}`);
        resolve({ error: `Claude exited with code ${code}`, result: null });
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve({
          sessionId: json.session_id,
          result: json.result || null,
        });
      } catch (err) {
        log(`Failed to parse claude output: ${err}`);
        log(`stdout (first 500): ${stdout.slice(0, 500)}`);
        resolve({ error: 'Failed to parse output', result: null });
      }
    });
  });
}

// --- Main ---

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    containerInput = await readInitialInput();
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Configure paths from input
  GROUP_WORK_DIR = containerInput.groupWorkDir || '/workspace/group';
  IPC_DIR = containerInput.ipcDir || '/workspace/ipc';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;

  // Set up IPC directories (needed by MCP server)
  const ipcInputDir = path.join(IPC_DIR, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'tasks'), { recursive: true });

  // Write MCP config to temp file (read by claude CLI)
  const mcpConfig = JSON.stringify({
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: IPC_DIR,
        },
      },
    },
  });
  const mcpConfigPath = path.join(IPC_DIR, 'mcp-config.json');
  fs.writeFileSync(mcpConfigPath, mcpConfig);

  // Load global CLAUDE.md (shared across all groups)
  const globalClaudeMdPath = path.join(path.dirname(GROUP_WORK_DIR), 'global', 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories
  const extraDirs: string[] = [];
  const extraBase = path.join(path.dirname(GROUP_WORK_DIR), 'extra');
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Set up stdin IPC reader
  const stdinReader = new StdinIpcReader();
  stdinReader.start();

  // Start relaying MCP server IPC files as stdout markers
  startIpcRelay();
  log('Stdio IPC mode: reading messages from stdin, relaying IPC via stdout');

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pendingMessages: string[] = [];
  for (const line of stdinReader.drainLines()) {
    try {
      const data = JSON.parse(line);
      if (data.type === 'message' && data.text) pendingMessages.push(data.text);
    } catch { /* ignore */ }
  }
  if (pendingMessages.length > 0) {
    log(`Draining ${pendingMessages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingMessages.join('\n');
  }

  // Query loop: spawn claude per turn → wait for IPC message → spawn again → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpConfigPath, globalClaudeMd, extraDirs);

      if (queryResult.sessionId) {
        sessionId = queryResult.sessionId;
      }

      if (queryResult.error) {
        writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: queryResult.error });
      } else {
        writeOutput({ status: 'success', result: queryResult.result, newSessionId: sessionId });
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for follow-up message or close signal
      const nextMessage = await waitForStdinMessage(stdinReader);
      if (nextMessage === null) {
        log('Close signal received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  } finally {
    stopIpcRelay();
  }
}

main();
