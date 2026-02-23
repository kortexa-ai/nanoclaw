/**
 * SSH Fleet Auto-Discovery and Auto-Provisioning for NanoClaw.
 *
 * Reads ~/.ssh/config, discovers fleet candidates by identity file,
 * probes reachability, provisions nodes (clone + build + workspace),
 * and writes fleet config so the runtime switches to SSH mode.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FLEET_SSH_IDENTITY, SSH_FLEET_CONFIG_PATH } from './config.js';
import { logger } from './logger.js';
import {
  SshNode,
  SshFleetConfig,
  saveFleetConfig,
  testSshConnection,
} from './ssh-fleet.js';

// --- Types ---

interface SshCandidate {
  alias: string;
  user: string;
  hostname: string;
  port: number;
}

interface ProbedCandidate extends SshCandidate {
  remoteHostname: string;
}

// --- SSH config parser ---

/**
 * Parse ~/.ssh/config and return candidates whose IdentityFile
 * contains the FLEET_SSH_IDENTITY string.
 */
export function parseSshConfig(): SshCandidate[] {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(configPath)) return [];

  const raw = fs.readFileSync(configPath, 'utf-8');
  const lines = raw.split('\n');

  const candidates: SshCandidate[] = [];
  let currentAliases: string[] = [];
  let currentUser = '';
  let currentHostname = '';
  let currentPort = 22;
  let currentIdentityFile = '';

  const flushBlock = () => {
    if (currentAliases.length === 0) return;
    if (!currentIdentityFile.includes(FLEET_SSH_IDENTITY)) return;

    for (const alias of currentAliases) {
      // Skip wildcard entries
      if (alias.includes('*') || alias.includes('?')) continue;

      // Resolve %h in Hostname pattern
      const hostname = currentHostname
        ? currentHostname.replace(/%h/g, alias)
        : alias;

      candidates.push({
        alias,
        user: currentUser || 'pi',
        hostname,
        port: currentPort,
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    const keyLower = key.toLowerCase();

    if (keyLower === 'host') {
      // Flush previous block
      flushBlock();
      // Start new block — Host can have multiple aliases
      currentAliases = value.split(/\s+/).filter(Boolean);
      currentUser = '';
      currentHostname = '';
      currentPort = 22;
      currentIdentityFile = '';
    } else if (keyLower === 'user') {
      currentUser = value;
    } else if (keyLower === 'hostname') {
      currentHostname = value;
    } else if (keyLower === 'port') {
      currentPort = parseInt(value, 10) || 22;
    } else if (keyLower === 'identityfile') {
      currentIdentityFile = value;
    }
  }

  // Flush last block
  flushBlock();

  return candidates;
}

// --- Probing ---

function sshExec(alias: string, command: string, timeoutMs = 15_000): string | null {
  try {
    const result = execSync(
      `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes ${alias} '${command}'`,
      { stdio: 'pipe', timeout: timeoutMs, encoding: 'utf-8' },
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Probe candidates for reachability and get their remote hostname.
 */
function probeCandidates(candidates: SshCandidate[]): ProbedCandidate[] {
  const probed: ProbedCandidate[] = [];

  for (const c of candidates) {
    const tempNode: SshNode = {
      id: c.alias,
      host: c.alias,   // Use alias — SSH config resolves it
      user: c.user,
      port: c.port,
      agentRunnerPath: '',
      workspacePath: '',
      maxConcurrentAgents: 2,
      status: 'offline',
    };

    if (!testSshConnection(tempNode)) {
      logger.debug({ alias: c.alias }, 'Fleet candidate unreachable');
      continue;
    }

    const remoteHostname = sshExec(c.alias, 'hostname');
    if (!remoteHostname) {
      logger.debug({ alias: c.alias }, 'Fleet candidate reachable but hostname failed');
      continue;
    }

    probed.push({ ...c, remoteHostname });
    logger.info({ alias: c.alias, remoteHostname }, 'Fleet candidate reachable');
  }

  return probed;
}

// --- Provisioning ---

/**
 * Provision a single remote node: clone/update repo, build agent-runner, create workspace.
 * Returns an SshNode on success, null on failure.
 */
function provisionNode(candidate: ProbedCandidate, repoUrl: string, branch: string): SshNode | null {
  const { alias } = candidate;
  const buildTimeout = 5 * 60 * 1000; // 5 minutes for npm install + build

  // Get home dir
  const home = sshExec(alias, 'echo $HOME');
  if (!home) {
    logger.warn({ alias }, 'Provision: failed to get home dir');
    return null;
  }

  // Verify Node.js exists
  const nodeVersion = sshExec(alias, 'node --version');
  if (!nodeVersion) {
    logger.warn({ alias }, 'Provision: Node.js not found, skipping');
    return null;
  }
  logger.info({ alias, nodeVersion }, 'Provision: Node.js found');

  // Clone or update repo
  const repoDir = `${home}/nanoclaw`;
  const cloneCmd = `test -d ${repoDir}/.git && (cd ${repoDir} && git fetch origin && git checkout ${branch} && git pull origin ${branch}) || (git clone ${repoUrl} ${repoDir} && cd ${repoDir} && git checkout ${branch})`;
  const cloneResult = sshExec(alias, cloneCmd, buildTimeout);
  if (cloneResult === null) {
    logger.warn({ alias }, 'Provision: git clone/update failed');
    return null;
  }

  // Build agent-runner
  const buildCmd = `cd ${repoDir}/ssh/agent-runner && npm install 2>&1 && npm run build 2>&1`;
  const buildResult = sshExec(alias, buildCmd, buildTimeout);
  if (buildResult === null) {
    logger.warn({ alias }, 'Provision: agent-runner build failed');
    return null;
  }
  logger.info({ alias }, 'Provision: agent-runner built');

  // Create workspace
  const workspacePath = `${home}/nanoclaw-workspace`;
  sshExec(alias, `mkdir -p ${workspacePath}`);

  const agentRunnerPath = `${repoDir}/ssh/agent-runner/dist/index.js`;

  return {
    id: candidate.remoteHostname,
    host: alias,  // Use SSH alias — config resolves to the right IP/key
    user: candidate.user,
    port: candidate.port,
    agentRunnerPath,
    workspacePath,
    maxConcurrentAgents: 2,
    status: 'online',
  };
}

// --- Main entry point ---

/**
 * Discover fleet candidates from SSH config, probe reachability,
 * provision remote nodes, and save fleet config.
 * Runs async — doesn't block the message loop.
 */
export async function discoverAndProvisionFleet(): Promise<void> {
  logger.info('Starting fleet auto-discovery');

  const candidates = parseSshConfig();
  if (candidates.length === 0) {
    logger.info('No fleet candidates found in SSH config');
    return;
  }

  logger.info({ count: candidates.length }, 'Fleet candidates found');
  const probedRaw = probeCandidates(candidates);
  if (probedRaw.length === 0) {
    logger.warn('No fleet candidates reachable');
    return;
  }

  // Deduplicate by remoteHostname — SSH config may have multiple aliases for the same host
  const seenHosts = new Map<string, ProbedCandidate>();
  for (const c of probedRaw) {
    if (!seenHosts.has(c.remoteHostname)) {
      seenHosts.set(c.remoteHostname, c);
    }
  }
  const probed = [...seenHosts.values()];
  if (probed.length < probedRaw.length) {
    logger.info({ before: probedRaw.length, after: probed.length }, 'Deduplicated fleet candidates');
  }

  // Get repo URL and branch from local git
  let repoUrl: string;
  let branch: string;
  try {
    repoUrl = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    branch = execSync('git branch --show-current', { encoding: 'utf-8', stdio: 'pipe' }).trim() || 'main';
  } catch {
    logger.error('Failed to get git remote/branch info');
    return;
  }

  // Determine which node is "self" (the orchestrator)
  const localHostname = os.hostname();
  const selfCandidates = probed.filter(c => c.remoteHostname === localHostname);
  const remoteCandidates = probed.filter(c => c.remoteHostname !== localHostname);

  const nodes: SshNode[] = [];

  // Self node — use local paths, build locally if needed
  for (const self of selfCandidates) {
    const home = os.homedir();
    const repoDir = path.resolve('.');
    const agentRunnerPath = path.join(repoDir, 'ssh', 'agent-runner', 'dist', 'index.js');
    const workspacePath = path.join(home, 'nanoclaw-workspace');

    // Build agent-runner locally if missing
    if (!fs.existsSync(agentRunnerPath)) {
      logger.info('Building agent-runner locally');
      try {
        execSync('npm install && npm run build', {
          cwd: path.join(repoDir, 'ssh', 'agent-runner'),
          stdio: 'pipe',
          timeout: 5 * 60 * 1000,
        });
      } catch (err) {
        logger.warn({ err }, 'Local agent-runner build failed, skipping self');
        continue;
      }
    }

    // Create workspace dir
    fs.mkdirSync(workspacePath, { recursive: true });

    nodes.push({
      id: self.remoteHostname,
      host: self.alias,
      user: self.user,
      port: self.port,
      agentRunnerPath,
      workspacePath,
      maxConcurrentAgents: 2,
      status: 'online',
    });
    logger.info({ alias: self.alias }, 'Self node added to fleet');
  }

  // Remote nodes — provision each
  for (const remote of remoteCandidates) {
    logger.info({ alias: remote.alias, hostname: remote.remoteHostname }, 'Provisioning remote node');
    const node = provisionNode(remote, repoUrl, branch);
    if (node) {
      nodes.push(node);
      logger.info({ alias: remote.alias, id: node.id }, 'Remote node provisioned');
    } else {
      logger.warn({ alias: remote.alias }, 'Failed to provision remote node');
    }
  }

  if (nodes.length === 0) {
    logger.warn('No nodes provisioned, fleet discovery complete with no results');
    return;
  }

  // Merge with existing config on disk (preserves nodes that are
  // temporarily unreachable during this scan)
  const existingRaw = fs.existsSync(SSH_FLEET_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(SSH_FLEET_CONFIG_PATH, 'utf-8')) as SshFleetConfig
    : null;

  const existingById = new Map<string, SshNode>();
  if (existingRaw) {
    for (const n of existingRaw.nodes) existingById.set(n.id, n);
  }

  const mergedNodes: SshNode[] = [];
  const discoveredIds = new Set(nodes.map(n => n.id));

  // Discovered nodes: update paths, preserve existing status
  for (const node of nodes) {
    const prev = existingById.get(node.id);
    mergedNodes.push(prev ? { ...node, status: prev.status } : node);
  }

  // Keep existing nodes not in this scan (health checks manage their status)
  for (const [id, node] of existingById) {
    if (!discoveredIds.has(id)) mergedNodes.push(node);
  }

  const fleetConfig: SshFleetConfig = {
    nodes: mergedNodes,
    meshSshKeyDistributed: true,
    defaultScheduling: 'least-loaded',
  };

  saveFleetConfig(fleetConfig);

  logger.info({ nodeCount: mergedNodes.length }, 'Fleet auto-discovery complete');
}
