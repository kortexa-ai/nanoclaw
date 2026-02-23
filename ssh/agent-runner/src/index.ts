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
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
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

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
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

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

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

// --- Session helpers ---

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(GROUP_WORK_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
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
 * IPC source abstraction: provides poll-during-query and wait-between-queries.
 */
interface IpcSource {
  /** Start polling for messages during a query. Calls onMessage/onClose. */
  startPolling(onMessage: (text: string) => void, onClose: () => void): void;
  /** Stop polling. */
  stopPolling(): void;
  /** Wait for the next message between queries. Returns null on close. */
  waitForMessage(): Promise<string | null>;
  /** Drain any pending messages (for initial prompt). */
  drainPending(): string[];
}

/** Stdin-based IPC source. */
function createStdinIpcSource(reader: StdinIpcReader): IpcSource {
  let polling = false;

  return {
    startPolling(onMessage, onClose) {
      polling = true;
      const poll = () => {
        if (!polling) return;
        for (const line of reader.drainLines()) {
          try {
            const data = JSON.parse(line);
            if (data.type === 'close') {
              onClose();
              return;
            }
            if (data.type === 'message' && data.text) {
              onMessage(data.text);
            }
          } catch (err) {
            log(`Failed to parse stdin IPC: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        setTimeout(poll, IPC_POLL_MS);
      };
      setTimeout(poll, IPC_POLL_MS);
    },
    stopPolling() {
      polling = false;
    },
    waitForMessage: () => waitForStdinMessage(reader),
    drainPending() {
      const messages: string[] = [];
      for (const line of reader.drainLines()) {
        try {
          const data = JSON.parse(line);
          if (data.type === 'message' && data.text) messages.push(data.text);
        } catch { /* ignore */ }
      }
      return messages;
    },
  };
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  ipcSource: IpcSource,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and close signal during the query
  let closedDuringQuery = false;
  ipcSource.startPolling(
    (text) => {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    },
    () => {
      log('Close signal detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
    },
  );

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = path.join(path.dirname(GROUP_WORK_DIR), 'global', 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
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

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: GROUP_WORK_DIR,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
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
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcSource.stopPolling();
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;

  // Set up IPC directories (needed by MCP server)
  const ipcInputDir = path.join(IPC_DIR, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'tasks'), { recursive: true });

  // Set up stdin IPC
  const stdinReader = new StdinIpcReader();
  stdinReader.start();
  const ipcSource = createStdinIpcSource(stdinReader);

  // Start relaying MCP server IPC files as stdout markers
  startIpcRelay();
  log('Stdio IPC mode: reading messages from stdin, relaying IPC via stdout');

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = ipcSource.drainPending();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, ipcSource, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next close).
      if (queryResult.closedDuringQuery) {
        log('Close signal consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or close signal
      const nextMessage = await ipcSource.waitForMessage();
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
