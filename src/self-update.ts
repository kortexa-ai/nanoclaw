import { execSync } from 'child_process';

import { logger } from './logger.js';

export interface SelfUpdateResult {
  updated: boolean;
  oldRev?: string;
  newRev?: string;
  summary?: string;
}

const EXEC_TIMEOUT = 120_000; // 2 minutes per command

function run(cmd: string): string {
  return execSync(cmd, {
    cwd: process.cwd(),
    timeout: EXEC_TIMEOUT,
    encoding: 'utf-8',
  }).trim();
}

export async function selfUpdate(): Promise<SelfUpdateResult> {
  const branch = run('git branch --show-current');
  logger.info({ branch }, 'Checking for updates');

  run('git fetch origin');

  const localRev = run('git rev-parse HEAD');
  const remoteRev = run(`git rev-parse origin/${branch}`);

  if (localRev === remoteRev) {
    logger.info('Already up to date');
    return { updated: false };
  }

  logger.info({ localRev: localRev.slice(0, 7), remoteRev: remoteRev.slice(0, 7) }, 'Update available, pulling');

  // Fast-forward only — fails if working tree is dirty
  run(`git pull origin ${branch} --ff-only`);

  // Install deps in case they changed
  run('npm install --omit=dev');

  // Rebuild
  run('npm run build');

  const summary = run(`git log --oneline ${localRev}..${remoteRev}`);

  logger.info({ oldRev: localRev.slice(0, 7), newRev: remoteRev.slice(0, 7) }, 'Self-update complete');

  return {
    updated: true,
    oldRev: localRev,
    newRev: remoteRev,
    summary,
  };
}
