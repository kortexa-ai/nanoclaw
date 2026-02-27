/**
 * SSH Runner for NanoClaw
 * Spawns agent execution on SSH fleet nodes.
 * Handles IPC via stdin/stdout multiplexing.
 * Self-contained — does not share process handling with container-runner.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  WALL_CLOCK_TIMEOUT,
} from './config.js';
import { logger } from './logger.js';
import {
  ContainerInput,
  ContainerOutput,
  createStdoutParser,
  readSecrets,
} from './container-runner.js';
import {
  SshNode,
  spawnSshAgent,
  syncGroupToNode,
  syncGroupFromNode,
  incrementAgentCount,
  decrementAgentCount,
  getNodeIpcDir,
  getNodeWorkDir,
} from './ssh-fleet.js';
import { IpcPayload } from './ipc-protocol.js';
import { RegisteredGroup } from './types.js';

/**
 * Handle an SSH agent process.
 * Parses stdout for OUTPUT and IPC markers, handles timeouts, writes logs.
 * SSH-specific: uses SIGTERM/SIGKILL for stop, logs mode as 'ssh'.
 */
function handleSshAgentProcess(
  proc: ChildProcess,
  group: RegisteredGroup,
  input: ContainerInput,
  containerName: string,
  startTime: number,
  logsDir: string,
  onOutput: ((output: ContainerOutput) => Promise<void>) | undefined,
  onIpc: ((payload: IpcPayload) => Promise<void>) | undefined,
  resolve: (result: ContainerOutput) => void,
): void {
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let wallClockTimedOut = false;
  let hadStreamingOutput = false;
  let newSessionId: string | undefined;
  let outputChain = Promise.resolve();
  let ipcChain = Promise.resolve();

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
  // graceful close signal has time to trigger before the hard kill fires.
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

  const killOnTimeout = () => {
    timedOut = true;
    logger.error({ group: group.name, containerName }, 'SSH agent timeout, stopping');
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 15000);
  };

  let timeout = setTimeout(killOnTimeout, timeoutMs);

  // Wall-clock hard cap — never resets, kills regardless of activity
  const wallClockTimer = setTimeout(() => {
    timedOut = true;
    wallClockTimedOut = true;
    logger.warn({ group: group.name, containerName }, 'Wall-clock timeout reached, killing agent');
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 15000);
  }, WALL_CLOCK_TIMEOUT);

  // Reset the timeout whenever there's activity (streaming output)
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(killOnTimeout, timeoutMs);
  };

  // Set up stdout parser for both OUTPUT and IPC markers
  const parser = createStdoutParser(
    group.name,
    // Output marker handler
    (parsed: ContainerOutput) => {
      if (parsed.newSessionId) {
        newSessionId = parsed.newSessionId;
      }
      hadStreamingOutput = true;
      resetTimeout();
      if (onOutput) {
        outputChain = outputChain.then(() => onOutput(parsed));
      }
    },
    // IPC marker handler (relayed from agent's local filesystem)
    onIpc ? (parsed: IpcPayload) => {
      ipcChain = ipcChain.then(() => onIpc(parsed));
    } : undefined,
  );

  proc.stdout!.on('data', (data) => {
    const chunk = data.toString();

    // Always accumulate for logging
    if (!stdoutTruncated) {
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn(
          { group: group.name, size: stdout.length },
          'SSH agent stdout truncated due to size limit',
        );
      } else {
        stdout += chunk;
      }
    }

    // Stream-parse for output and IPC markers
    if (onOutput || onIpc) {
      parser.feed(chunk);
    }
  });

  proc.stderr!.on('data', (data) => {
    const chunk = data.toString();
    const lines = chunk.trim().split('\n');
    for (const line of lines) {
      if (line) logger.debug({ container: group.folder }, line);
    }
    // Don't reset timeout on stderr — SDK writes debug logs continuously.
    if (stderrTruncated) return;
    const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
    if (chunk.length > remaining) {
      stderr += chunk.slice(0, remaining);
      stderrTruncated = true;
      logger.warn(
        { group: group.name, size: stderr.length },
        'SSH agent stderr truncated due to size limit',
      );
    } else {
      stderr += chunk;
    }
  });

  proc.on('close', (code) => {
    clearTimeout(timeout);
    clearTimeout(wallClockTimer);
    const duration = Date.now() - startTime;
    const timeoutKind: 'idle' | 'wall-clock' | undefined = wallClockTimedOut ? 'wall-clock' : timedOut ? 'idle' : undefined;

    if (timedOut) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const timeoutLog = path.join(logsDir, `container-${ts}.log`);
      fs.writeFileSync(timeoutLog, [
        `=== Agent Run Log (TIMEOUT${wallClockTimedOut ? ' - WALL CLOCK' : ''}) ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Agent: ${containerName}`,
        `Mode: ssh`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Had Streaming Output: ${hadStreamingOutput}`,
        `Timeout Kind: ${timeoutKind}`,
      ].join('\n'));

      // Wall-clock timeout always reports the kind so index.ts can clear the session
      if (wallClockTimedOut) {
        logger.warn(
          { group: group.name, containerName, duration, code },
          'SSH agent hit wall-clock timeout',
        );
        Promise.all([outputChain, ipcChain]).then(() => {
          resolve({
            status: hadStreamingOutput ? 'success' : 'error',
            result: null,
            newSessionId,
            timedOut: 'wall-clock',
            error: hadStreamingOutput ? undefined : `Agent hit wall-clock timeout after ${WALL_CLOCK_TIMEOUT}ms`,
          });
        });
        return;
      }

      // Idle timeout after output = idle cleanup, not failure.
      if (hadStreamingOutput) {
        logger.info(
          { group: group.name, containerName, duration, code },
          'SSH agent timed out after output (idle cleanup)',
        );
        Promise.all([outputChain, ipcChain]).then(() => {
          resolve({
            status: 'success',
            result: null,
            newSessionId,
            timedOut: 'idle',
          });
        });
        return;
      }

      logger.error(
        { group: group.name, containerName, duration, code },
        'SSH agent timed out with no output',
      );

      resolve({
        status: 'error',
        result: null,
        error: `Agent timed out after ${configTimeout}ms`,
        timedOut: 'idle',
      });
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Agent Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `IsMain: ${input.isMain}`,
      `Mode: ssh`,
      `Duration: ${duration}ms`,
      `Exit Code: ${code}`,
      `Stdout Truncated: ${stdoutTruncated}`,
      `Stderr Truncated: ${stderrTruncated}`,
      ``,
    ];

    const isError = code !== 0;

    if (isVerbose || isError) {
      logLines.push(
        `=== Input ===`,
        JSON.stringify(input, null, 2),
        ``,
        `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
        stderr,
        ``,
        `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
        stdout,
      );
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``,
      );
    }

    fs.writeFileSync(logFile, logLines.join('\n'));
    logger.debug({ logFile, verbose: isVerbose }, 'SSH agent log written');

    if (code !== 0) {
      logger.error(
        {
          group: group.name,
          code,
          duration,
          stderr,
          stdout,
          logFile,
        },
        'SSH agent exited with error',
      );

      resolve({
        status: 'error',
        result: null,
        error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
      });
      return;
    }

    // Streaming mode: wait for output/ipc chains to settle, return completion marker
    if (onOutput) {
      Promise.all([outputChain, ipcChain]).then(() => {
        logger.info(
          { group: group.name, duration, newSessionId },
          'SSH agent completed (streaming mode)',
        );
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
      });
      return;
    }

    // Non-streaming fallback: should not normally occur for SSH agents
    resolve({
      status: 'success',
      result: null,
      newSessionId,
    });
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    logger.error({ group: group.name, containerName, error: err }, 'SSH agent spawn error');
    resolve({
      status: 'error',
      result: null,
      error: `SSH agent spawn error: ${err.message}`,
    });
  });
}

/**
 * Run an agent on an SSH node.
 */
export async function runSshAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  node?: SshNode,
  onIpc?: (payload: IpcPayload) => Promise<void>,
): Promise<ContainerOutput> {
  if (!node) {
    return {
      status: 'error',
      result: null,
      error: 'No SSH node provided',
    };
  }

  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-ssh-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      containerName,
      node: node.id,
      host: node.host,
      isMain: input.isMain,
    },
    'Spawning SSH agent',
  );

  // Sync group directory to node before spawning
  try {
    syncGroupToNode(node, group.folder);
  } catch (err) {
    return {
      status: 'error',
      result: null,
      error: `Failed to sync group dir to node: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  incrementAgentCount(node.id);

  // Build SSH-specific input (extends ContainerInput with SSH fields)
  const sshInput = {
    ...input,
    ipcMode: 'stdio' as const,
    groupWorkDir: getNodeWorkDir(node, group.folder),
    ipcDir: getNodeIpcDir(node, group.folder),
  };

  return new Promise((resolve) => {
    const sshProc = spawnSshAgent(node, group.folder);
    onProcess(sshProc, containerName);

    // Pass secrets via stdin as first JSON line (keep stdin open for IPC)
    sshInput.secrets = readSecrets();
    sshProc.stdin!.write(JSON.stringify(sshInput) + '\n');
    // Don't close stdin — it's used for follow-up messages in stdio mode
    // Remove secrets from input so they don't appear in logs
    delete sshInput.secrets;

    const wrappedResolve = (result: ContainerOutput) => {
      decrementAgentCount(node.id);
      // Sync group directory back from node
      try {
        syncGroupFromNode(node, group.folder);
      } catch (err) {
        logger.warn({ node: node.id, group: group.name, err }, 'Post-run sync from node failed');
      }
      resolve(result);
    };

    handleSshAgentProcess(sshProc, group, input, containerName, startTime, logsDir, onOutput, onIpc, wrappedResolve);
  });
}
