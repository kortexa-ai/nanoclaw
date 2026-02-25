import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  FLEET_REDISCOVERY_INTERVAL,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
  UPDATE_CHECK_INTERVAL,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getRecentMessages,
} from './db.js';
import { GroupQueue, IpcHandlers } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { IpcDeps, processIpcPayload, startIpcWatcher } from './ipc.js';
import { IpcPayload } from './ipc-protocol.js';
import {
  getFleetConfig,
  loadFleetConfig,
  selectNode,
  startHealthChecks,
  stopHealthChecks,
} from './ssh-fleet.js';
import { runSshAgent } from './ssh-runner.js';
import { discoverAndProvisionFleet, parseSshConfig } from './ssh-discover.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let discoveryWorkerRunning = false;
let rediscoveryTimer: ReturnType<typeof setInterval> | null = null;
let updateWorkerRunning = false;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

function forkDiscoveryWorker(): void {
  if (discoveryWorkerRunning) {
    logger.debug('Discovery worker already running, skipping');
    return;
  }
  discoveryWorkerRunning = true;

  import('child_process').then(({ fork }) => {
    const child = fork(
      new URL('./ssh-discover-worker.js', import.meta.url).pathname,
      [], { stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      discoveryWorkerRunning = false;
      if (code === 0) {
        loadFleetConfig();
        if (detectRuntimeMode() === 'ssh') {
          startHealthChecks();
          logger.info('Fleet discovery complete, SSH runtime active');
        }
      } else {
        logger.error({ code }, 'Fleet discovery worker exited with error');
      }
    });
  });
}

function triggerSelfUpdate(): void {
  if (updateWorkerRunning) {
    logger.debug('Update worker already running, skipping');
    return;
  }
  updateWorkerRunning = true;

  import('child_process').then(({ fork }) => {
    const child = fork(
      new URL('./self-update-worker.js', import.meta.url).pathname,
      [], { silent: true },
    );

    let output = '';
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      logger.warn({ stderr: data.toString().trim() }, 'Self-update worker stderr');
    });

    child.on('exit', async (code) => {
      updateWorkerRunning = false;

      if (code !== 0) {
        logger.error({ code }, 'Self-update worker failed');
        // Notify main group about failure
        try {
          const mainJid = Object.entries(registeredGroups)
            .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
          if (mainJid && ipcDeps) {
            await ipcDeps.sendMessage(mainJid, `Self-update failed (exit code ${code})`);
          }
        } catch { /* best effort */ }
        return;
      }

      try {
        const result = JSON.parse(output.trim());
        if (result.updated) {
          logger.info(
            { oldRev: result.oldRev?.slice(0, 7), newRev: result.newRev?.slice(0, 7) },
            'Self-update successful, restarting',
          );
          // Notify main group before restart
          const mainJid = Object.entries(registeredGroups)
            .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
          if (mainJid && ipcDeps) {
            const summary = result.summary
              ? result.summary.split('\n').map((l: string) => `- ${l}`).join('\n')
              : '';
            await ipcDeps.sendMessage(
              mainJid,
              `Updated from \`${result.oldRev?.slice(0, 7)}\` to \`${result.newRev?.slice(0, 7)}\`:\n${summary}`,
            );
          }
          // Exit — systemd/launchd restarts with new code
          process.exit(0);
        } else {
          logger.debug('Already up to date');
        }
      } catch (err) {
        logger.error({ err, output }, 'Failed to parse self-update result');
      }
    });
  });
}

function triggerFleetWipe(): void {
  logger.warn('Fleet wipe triggered — wiping all nodes and self');

  import('child_process').then(({ spawn }) => {
    const scriptPath = new URL('../scripts/self-wipe.sh', import.meta.url).pathname;
    const child = spawn('bash', [scriptPath], {
      stdio: 'inherit',
      detached: true,
    });
    // Detach so the wipe script survives if we die mid-way
    child.unref();

    // Notify main group (best effort — we might be dead before it sends)
    const mainJid = Object.entries(registeredGroups)
      .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
    if (mainJid && ipcDeps) {
      ipcDeps.sendMessage(mainJid, 'Fleet wipe initiated. Goodbye.').catch(() => {});
    }

    // Exit after a short delay — give the wipe script time to read fleet config
    // and the message time to send. The script is detached so it survives our exit.
    setTimeout(() => {
      logger.warn('Fleet wipe: orchestrator exiting');
      process.exit(0);
    }, 5000);
  });
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Determine runtime mode
  const mode = detectRuntimeMode();
  const isSshMode = mode === 'ssh';

  const containerInput = {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    assistantName: ASSISTANT_NAME,
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

// Shared IPC deps — used by both file-based IPC watcher and stdout-relayed IPC (SSH mode)
let ipcDeps: IpcDeps;

function ensureContainerSystemRunning(): void {
  // Docker mode: verify runtime and clean up orphans
  // SSH mode: no Docker needed
  if (detectRuntimeMode() === 'docker') {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
  }
}

async function main(): Promise<void> {
  // Load SSH fleet config before runtime check (affects which runtime is used)
  loadFleetConfig();
  let runtimeMode = detectRuntimeMode();
  logger.info({ runtimeMode }, 'Runtime mode detected');

  if (runtimeMode === 'docker') {
    const fleetCandidates = parseSshConfig();  // fast — just reads a file
    if (fleetCandidates.length > 0) {
      // Fleet candidates found in SSH config — skip Docker, start async discovery.
      // Runs in a child process to avoid blocking the event loop (probing uses execSync).
      logger.info({ candidates: fleetCandidates.length }, 'Fleet candidates in SSH config, starting auto-discovery');
      forkDiscoveryWorker();
      // Start periodic re-discovery
      rediscoveryTimer = setInterval(() => {
        logger.debug('Starting periodic fleet re-discovery');
        forkDiscoveryWorker();
      }, FLEET_REDISCOVERY_INTERVAL);
    } else {
      ensureContainerSystemRunning();  // Docker required (existing behavior)
    }
  } else {
    startHealthChecks();  // existing behavior
    // Start periodic re-discovery for existing SSH fleet
    rediscoveryTimer = setInterval(() => {
      logger.debug('Starting periodic fleet re-discovery');
      forkDiscoveryWorker();
    }, FLEET_REDISCOVERY_INTERVAL);
  }

  // Periodic self-update check
  updateCheckTimer = setInterval(() => {
    logger.debug('Checking for updates');
    triggerSelfUpdate();
  }, UPDATE_CHECK_INTERVAL);

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (statusHeartbeatTimer) clearInterval(statusHeartbeatTimer);
    if (rediscoveryTimer) clearInterval(rediscoveryTimer);
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    stopHealthChecks();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onCommand: (action: string) => {
      logger.info({ action }, 'Command received via MQTT');
      if (action === 'self_update') triggerSelfUpdate();
      else if (action === 'fleet_wipe') triggerFleetWipe();
      else logger.warn({ action }, 'Unknown command action');
    },
    onHistoryRequest: (limit: number) => {
      const rows = getRecentMessages('mqtt:local', Math.min(limit, 200));
      const messages = rows.map(r => ({
        id: r.id,
        content: r.content,
        timestamp: r.timestamp,
        direction: r.is_from_me ? 'received' : 'sent',
        sender: r.sender_name,
      }));
      mqtt.publishHistory(messages);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  startIpcWatcher(ipcDeps);
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Status heartbeat — publish enriched status to MQTT every 30s
  const pkgVersion = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  ).version as string;

  let gitRev = 'unknown';
  try {
    gitRev = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { /* non-git deployment */ }

  const publishStatusHeartbeat = () => {
    const fleet = getFleetConfig();
    mqtt.publishStatus({
      status: 'online',
      hostname: os.hostname(),
      version: pkgVersion,
      uptime: Math.floor(process.uptime()),
      fleetNodes: fleet?.nodes.length ?? 0,
      activeAgents: queue.activeAgentCount,
      gitRev,
      assistantName: ASSISTANT_NAME,
      fleet: fleet?.nodes ?? [],
    });
  };

  publishStatusHeartbeat(); // Immediate first publish
  statusHeartbeatTimer = setInterval(publishStatusHeartbeat, 30_000);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
