/**
 * Worker process for self-update.
 * Runs in a forked child process so that the execSync calls
 * in git/npm don't block the main event loop.
 * Writes JSON result to stdout for the parent to read.
 */
import { selfUpdate } from './self-update.js';

selfUpdate()
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Self-update failed:', err);
    process.exit(1);
  });
