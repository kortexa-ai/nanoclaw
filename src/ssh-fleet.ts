/**
 * SSH Fleet Manager for NanoClaw
 * Manages a fleet of SSH nodes (Raspberry Pis, etc.) as agent execution nodes.
 * Handles health checks, least-loaded scheduling, SSH spawning, and group dir sync.
 */
import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { SSH_FLEET_CONFIG_PATH, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const HEALTH_CHECK_INTERVAL = 60_000; // 60s
const SSH_CONNECT_TIMEOUT = 10; // seconds
const SSH_OPTIONS = [
  '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
];

// --- Types ---

export interface SshNode {
  id: string;
  host: string;
  user: string;
  port: number;
  agentRunnerPath: string;
  workspacePath: string;
  maxConcurrentAgents: number;
  status: 'online' | 'offline';
  ip?: string;
  gitRev?: string;
}

export interface SshFleetConfig {
  nodes: SshNode[];
  meshSshKeyDistributed: boolean;
  defaultScheduling: 'least-loaded';
}

// --- Fleet state ---

let config: SshFleetConfig | null = null;
let activeAgentCounts = new Map<string, number>(); // nodeId → count
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

// --- Config management ---

export function loadFleetConfig(): SshFleetConfig | null {
  try {
    if (!fs.existsSync(SSH_FLEET_CONFIG_PATH)) return null;
    const raw = fs.readFileSync(SSH_FLEET_CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
    // Initialize agent counts for new nodes
    for (const node of config!.nodes) {
      if (!activeAgentCounts.has(node.id)) {
        activeAgentCounts.set(node.id, 0);
      }
    }
    logger.info({ nodeCount: config!.nodes.length }, 'SSH fleet config loaded');
    return config;
  } catch (err) {
    logger.error({ err }, 'Failed to load SSH fleet config');
    return null;
  }
}

export function saveFleetConfig(newConfig: SshFleetConfig): void {
  config = newConfig;
  fs.mkdirSync(path.dirname(SSH_FLEET_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(SSH_FLEET_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  logger.info('SSH fleet config saved');
}

export function getFleetConfig(): SshFleetConfig | null {
  return config;
}

export function isFleetConfigured(): boolean {
  return config !== null && config.nodes.length > 0;
}

// --- Health checks ---

function sshTarget(node: SshNode): string {
  return `${node.user}@${node.host}`;
}

function sshArgs(node: SshNode): string[] {
  return [...SSH_OPTIONS, '-p', String(node.port), sshTarget(node)];
}

/**
 * Test SSH connectivity to a node.
 * Returns true if reachable, false otherwise.
 */
export function testSshConnection(node: SshNode): boolean {
  try {
    execSync(
      `ssh ${SSH_OPTIONS.join(' ')} -p ${node.port} ${sshTarget(node)} 'echo ok'`,
      { stdio: 'pipe', timeout: (SSH_CONNECT_TIMEOUT + 5) * 1000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a health check on a single node.
 * Tests SSH, checks agent-runner exists, updates status.
 */
export async function healthCheck(node: SshNode): Promise<boolean> {
  try {
    const result = execSync(
      `ssh ${SSH_OPTIONS.join(' ')} -p ${node.port} ${sshTarget(node)} 'uptime && test -f ${node.agentRunnerPath} && echo agent-runner-ok && hostname -I 2>/dev/null | awk "{print \\$1}" && cd ~/nanoclaw 2>/dev/null && git rev-parse --short HEAD 2>/dev/null'`,
      { stdio: 'pipe', timeout: (SSH_CONNECT_TIMEOUT + 10) * 1000, encoding: 'utf-8' },
    );
    const isHealthy = result.includes('agent-runner-ok');
    if (node.status !== 'online' && isHealthy) {
      logger.info({ nodeId: node.id, host: node.host }, 'SSH node came back online');
    }
    node.status = isHealthy ? 'online' : 'offline';

    // Parse IP and git rev from health check output
    const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
    const okIdx = lines.indexOf('agent-runner-ok');
    if (okIdx >= 0) {
      // Lines after agent-runner-ok: IP, then git rev
      if (lines[okIdx + 1]) node.ip = lines[okIdx + 1];
      if (lines[okIdx + 2]) node.gitRev = lines[okIdx + 2];
    }

    return isHealthy;
  } catch (err) {
    if (node.status !== 'offline') {
      logger.warn({ nodeId: node.id, host: node.host }, 'SSH node went offline');
    }
    node.status = 'offline';
    return false;
  }
}

/**
 * Start periodic health checks on all nodes.
 */
export function startHealthChecks(): void {
  if (!config || healthCheckTimer) return;

  const runChecks = async () => {
    if (!config) return;
    for (const node of config.nodes) {
      await healthCheck(node);
    }
  };

  // Initial check
  runChecks().catch(err => logger.error({ err }, 'Health check error'));

  healthCheckTimer = setInterval(() => {
    runChecks().catch(err => logger.error({ err }, 'Health check error'));
  }, HEALTH_CHECK_INTERVAL);

  logger.info({ interval: HEALTH_CHECK_INTERVAL }, 'SSH fleet health checks started');
}

export function stopHealthChecks(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// --- Scheduling ---

/**
 * Pick the best node for a new agent.
 * Uses least-loaded scheduling with optional group affinity.
 */
export function selectNode(groupAffinityNodeId?: string): SshNode | null {
  if (!config) return null;

  const onlineNodes = config.nodes.filter(n => n.status === 'online');
  if (onlineNodes.length === 0) return null;

  // Check group affinity first
  if (groupAffinityNodeId) {
    const preferred = onlineNodes.find(n => n.id === groupAffinityNodeId);
    if (preferred) {
      const count = activeAgentCounts.get(preferred.id) || 0;
      if (count < preferred.maxConcurrentAgents) return preferred;
    }
    // Affinity node is full or offline — fall through to least-loaded
  }

  // Least-loaded: pick node with fewest active agents that has capacity
  let bestNode: SshNode | null = null;
  let bestCount = Infinity;

  for (const node of onlineNodes) {
    const count = activeAgentCounts.get(node.id) || 0;
    if (count < node.maxConcurrentAgents && count < bestCount) {
      bestNode = node;
      bestCount = count;
    }
  }

  return bestNode;
}

// --- Agent tracking ---

export function incrementAgentCount(nodeId: string): void {
  const count = activeAgentCounts.get(nodeId) || 0;
  activeAgentCounts.set(nodeId, count + 1);
}

export function decrementAgentCount(nodeId: string): void {
  const count = activeAgentCounts.get(nodeId) || 0;
  activeAgentCounts.set(nodeId, Math.max(0, count - 1));
}

export function getAgentCount(nodeId: string): number {
  return activeAgentCounts.get(nodeId) || 0;
}

// --- Group directory sync ---

/**
 * Sync a group's directory to a node before agent spawn.
 */
export function syncGroupToNode(node: SshNode, groupFolder: string): void {
  const localDir = path.join(GROUPS_DIR, groupFolder) + '/';
  const remoteDir = `${sshTarget(node)}:${node.workspacePath}/${groupFolder}/`;

  logger.debug({ nodeId: node.id, groupFolder }, 'Syncing group dir to node');

  try {
    execSync(
      `rsync -az --delete -e 'ssh ${SSH_OPTIONS.join(' ')} -p ${node.port}' ${localDir} ${remoteDir}`,
      { stdio: 'pipe', timeout: 60_000 },
    );
  } catch (err) {
    logger.error({ nodeId: node.id, groupFolder, err }, 'Failed to sync group dir to node');
    throw err;
  }
}

/**
 * Sync a group's directory back from a node after agent exits.
 */
export function syncGroupFromNode(node: SshNode, groupFolder: string): void {
  const localDir = path.join(GROUPS_DIR, groupFolder) + '/';
  const remoteDir = `${sshTarget(node)}:${node.workspacePath}/${groupFolder}/`;

  logger.debug({ nodeId: node.id, groupFolder }, 'Syncing group dir from node');

  try {
    execSync(
      `rsync -az -e 'ssh ${SSH_OPTIONS.join(' ')} -p ${node.port}' ${remoteDir} ${localDir}`,
      { stdio: 'pipe', timeout: 60_000 },
    );
  } catch (err) {
    logger.warn({ nodeId: node.id, groupFolder, err }, 'Failed to sync group dir from node (non-fatal)');
  }
}

// --- SSH spawn ---

/**
 * Spawn an agent process on a node via SSH.
 * Returns the SSH child process with stdin/stdout piped through.
 */
export function spawnSshAgent(node: SshNode, groupFolder: string): ChildProcess {
  const workDir = `${node.workspacePath}/${groupFolder}`;
  const ipcDir = `${node.workspacePath}/${groupFolder}/ipc`;
  const cmd = `mkdir -p ${workDir} ${ipcDir}/messages ${ipcDir}/tasks ${ipcDir}/input && cd ${workDir} && exec node ${node.agentRunnerPath}`;

  const proc = spawn('ssh', [
    ...sshArgs(node),
    cmd,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return proc;
}

/**
 * Get the IPC directory path on a node for a group.
 */
export function getNodeIpcDir(node: SshNode, groupFolder: string): string {
  return `${node.workspacePath}/${groupFolder}/ipc`;
}

/**
 * Get the workspace directory path on a node for a group.
 */
export function getNodeWorkDir(node: SshNode, groupFolder: string): string {
  return `${node.workspacePath}/${groupFolder}`;
}
