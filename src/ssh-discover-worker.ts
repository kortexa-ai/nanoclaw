/**
 * Worker process for fleet auto-discovery.
 * Runs in a forked child process so that the execSync calls
 * in probing/provisioning don't block the main event loop.
 */
import { discoverAndProvisionFleet } from './ssh-discover.js';

discoverAndProvisionFleet()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fleet auto-discovery failed:', err);
    process.exit(1);
  });
