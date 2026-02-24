import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SelfUpdateResult {
  updated: boolean;
  oldRev?: string;
  newRev?: string;
  summary?: string;
}

const EXEC_TIMEOUT = 120_000; // 2 minutes per command
const FLEET_UPDATE_TIMEOUT = 180_000; // 3 minutes per node

// Ensure node/npm binaries are on PATH (nvm sets this for the login shell
// but execSync uses /bin/sh which may not inherit it)
const execPath = process.execPath; // e.g. /home/pi/.nvm/versions/node/v25.0.0/bin/node
const nodeBin = execPath.replace(/\/node$/, '');
const envPath = `${nodeBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;

function run(cmd: string): string {
  return execSync(cmd, {
    cwd: process.cwd(),
    timeout: EXEC_TIMEOUT,
    encoding: 'utf-8',
    env: { ...process.env, PATH: envPath },
  }).trim();
}

// Log to stderr so stdout stays clean for JSON result
function log(msg: string): void {
  console.error(`[self-update] ${msg}`);
}

export async function selfUpdate(): Promise<SelfUpdateResult> {
  const branch = run('git branch --show-current');
  log(`Checking for updates on ${branch}`);

  run('git fetch origin');

  const localRev = run('git rev-parse HEAD');
  const remoteRev = run(`git rev-parse origin/${branch}`);

  if (localRev === remoteRev) {
    log('Already up to date');
    return { updated: false };
  }

  log(`Update available: ${localRev.slice(0, 7)} → ${remoteRev.slice(0, 7)}`);

  // Jump to remote HEAD (handles both fast-forward and force-pushed rebases)
  // npm install can dirty package-lock.json, build can dirty dist/, etc.
  run(`git reset --hard origin/${branch}`);

  // Install deps in case they changed (include devDeps — typescript is needed for build)
  // --production=false overrides NODE_ENV=production set by systemd
  run('npm install --production=false');

  // Rebuild
  run('npm run build');

  const summary = run(`git log --oneline ${localRev}..${remoteRev}`);

  log(`Self-update complete: ${localRev.slice(0, 7)} → ${remoteRev.slice(0, 7)}`);

  // Propagate to fleet nodes (fire-and-forget — don't block restart)
  propagateToFleet(branch);

  return {
    updated: true,
    oldRev: localRev,
    newRev: remoteRev,
    summary,
  };
}

/**
 * Update fleet nodes asynchronously. Each node gets its own SSH call
 * that fetches + resets + rebuilds. Failures are logged but don't
 * block the orchestrator restart.
 */
function propagateToFleet(branch: string): void {
  const fleetPath = path.resolve(process.cwd(), 'data', 'ssh-fleet.json');
  if (!fs.existsSync(fleetPath)) return;

  let config: { nodes: Array<{ id: string; host: string; user: string; port: number }> };
  try {
    config = JSON.parse(fs.readFileSync(fleetPath, 'utf-8'));
  } catch {
    log('Failed to read fleet config, skipping fleet propagation');
    return;
  }

  const localHostname = os.hostname();
  const sshOpts = '-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes';
  const updateCmd = `cd ~/nanoclaw && git fetch origin && git reset --hard origin/${branch} && npm install --production=false 2>&1 && npm run build 2>&1 && cd ssh/agent-runner && npm install 2>&1 && npm run build 2>&1`;

  for (const node of config.nodes) {
    // Skip self — orchestrator is already updated
    if (node.id === localHostname) continue;

    const target = `${node.user}@${node.host}`;
    const cmd = `ssh ${sshOpts} -p ${node.port} ${target} '${updateCmd}'`;

    log(`Propagating update to ${node.id} (${target})`);
    exec(cmd, { timeout: FLEET_UPDATE_TIMEOUT, env: { ...process.env, PATH: envPath } }, (err, stdout, stderr) => {
      if (err) {
        log(`Fleet update failed for ${node.id}: ${err.message}`);
      } else {
        log(`Fleet update complete for ${node.id}`);
      }
    });
  }
}
