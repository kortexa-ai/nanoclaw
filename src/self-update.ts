import { execSync } from 'child_process';

export interface SelfUpdateResult {
  updated: boolean;
  oldRev?: string;
  newRev?: string;
  summary?: string;
}

const EXEC_TIMEOUT = 120_000; // 2 minutes per command

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

  // Fast-forward only — fails if working tree is dirty
  run(`git pull origin ${branch} --ff-only`);

  // Install deps in case they changed (include devDeps — typescript is needed for build)
  // --production=false overrides NODE_ENV=production set by systemd
  run('npm install --production=false');

  // Rebuild
  run('npm run build');

  const summary = run(`git log --oneline ${localRev}..${remoteRev}`);

  log(`Self-update complete: ${localRev.slice(0, 7)} → ${remoteRev.slice(0, 7)}`);

  return {
    updated: true,
    oldRev: localRev,
    newRev: remoteRev,
    summary,
  };
}
