/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Docker containers.
 * Handles IPC via file-based polling.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { IpcPayload } from './ipc-protocol.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const IPC_START_MARKER = '---NANOCLAW_IPC_START---';
export const IPC_END_MARKER = '---NANOCLAW_IPC_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  timedOut?: 'idle' | 'wall-clock';
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Secrets are passed via stdin instead (see readSecrets()).
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Parse stdout for OUTPUT and IPC markers.
 * Calls onOutput for result markers and onIpc for IPC markers.
 * Returns functions to manage the parse state.
 */
export function createStdoutParser(
  groupName: string,
  onOutputParsed: (parsed: ContainerOutput) => void,
  onIpcParsed?: (parsed: IpcPayload) => void,
) {
  let parseBuffer = '';

  return {
    feed(chunk: string) {
      parseBuffer += chunk;

      // Process all complete marker pairs in order
      while (true) {
        const outputStart = parseBuffer.indexOf(OUTPUT_START_MARKER);
        const ipcStart = parseBuffer.indexOf(IPC_START_MARKER);

        // Find the earliest marker
        let markerType: 'output' | 'ipc' | null = null;
        let startIdx = -1;
        let startMarker: string;
        let endMarker: string;

        if (outputStart !== -1 && (ipcStart === -1 || outputStart < ipcStart)) {
          markerType = 'output';
          startIdx = outputStart;
          startMarker = OUTPUT_START_MARKER;
          endMarker = OUTPUT_END_MARKER;
        } else if (ipcStart !== -1) {
          markerType = 'ipc';
          startIdx = ipcStart;
          startMarker = IPC_START_MARKER;
          endMarker = IPC_END_MARKER;
        }

        if (markerType === null) break;

        const endIdx = parseBuffer.indexOf(endMarker!, startIdx);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = parseBuffer
          .slice(startIdx + startMarker!.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + endMarker!.length);

        try {
          const parsed = JSON.parse(jsonStr);
          if (markerType === 'output') {
            onOutputParsed(parsed);
          } else if (onIpcParsed) {
            onIpcParsed(parsed);
          }
        } catch (err) {
          logger.warn(
            { group: groupName, markerType, error: err },
            'Failed to parse streamed marker payload',
          );
        }
      }
    },
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onIpc?: (payload: IpcPayload) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input) + '\n');
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    handleAgentProcess(container, group, input, containerName, containerArgs, mounts, startTime, logsDir, onOutput, onIpc, resolve);
  });
}

/**
 * Handle a Docker container agent process.
 * Parses stdout for OUTPUT and IPC markers, handles timeouts, writes logs.
 */
function handleAgentProcess(
  proc: ChildProcess,
  group: RegisteredGroup,
  input: ContainerInput,
  containerName: string,
  containerArgs: string[],
  mounts: { hostPath: string; containerPath: string; readonly: boolean }[],
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
    logger.error({ group: group.name, containerName }, 'Agent timeout, stopping gracefully');
    exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
      if (err) {
        logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
        proc.kill('SIGKILL');
      }
    });
  };

  let timeout = setTimeout(killOnTimeout, timeoutMs);

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
    // IPC marker handler
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
          'Agent stdout truncated due to size limit',
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

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

  proc.on('close', (code) => {
    clearTimeout(timeout);
    const duration = Date.now() - startTime;

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Agent: ${containerName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Had Streaming Output: ${hadStreamingOutput}`,
      ].join('\n'));

      // Timeout after output = idle cleanup, not failure.
      // The agent already sent its response; this is just the
      // process being reaped after the idle period expired.
      if (hadStreamingOutput) {
        logger.info(
          { group: group.name, containerName, duration, code },
          'Agent timed out after output (idle cleanup)',
        );
        Promise.all([outputChain, ipcChain]).then(() => {
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      logger.error(
        { group: group.name, containerName, duration, code },
        'Agent timed out with no output',
      );

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent timed out after ${configTimeout}ms`,
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
      `Mode: docker`,
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
      );
      if (containerArgs.length > 0) {
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
        );
      }
      if (mounts.length > 0) {
        logLines.push(
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
        );
      }
      logLines.push(
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
      if (mounts.length > 0) {
        logLines.push(
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }
    }

    fs.writeFileSync(logFile, logLines.join('\n'));
    logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

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
        'Agent exited with error',
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
          'Agent completed (streaming mode)',
        );
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
      });
      return;
    }

    // Legacy mode: parse the last output marker pair from accumulated stdout
    try {
      // Extract JSON between sentinel markers for robust parsing
      const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
      const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

      let jsonLine: string;
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        jsonLine = stdout
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
      } else {
        // Fallback: last non-empty line (backwards compatibility)
        const lines = stdout.trim().split('\n');
        jsonLine = lines[lines.length - 1];
      }

      const output: ContainerOutput = JSON.parse(jsonLine);

      logger.info(
        {
          group: group.name,
          duration,
          status: output.status,
          hasResult: !!output.result,
        },
        'Agent completed',
      );

      resolve(output);
    } catch (err) {
      logger.error(
        {
          group: group.name,
          stdout,
          stderr,
          error: err,
        },
        'Failed to parse agent output',
      );

      resolve({
        status: 'error',
        result: null,
        error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    logger.error({ group: group.name, containerName, error: err }, 'Agent spawn error');
    resolve({
      status: 'error',
      result: null,
      error: `Agent spawn error: ${err.message}`,
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
