/**
 * SSH runtime detection for NanoClaw.
 * Determines whether to use SSH fleet or Docker containers.
 */
import { isFleetConfigured } from './ssh-fleet.js';

/** Runtime mode: docker (containers) or ssh (SSH fleet). */
export type RuntimeMode = 'docker' | 'ssh';

/**
 * Detect which runtime mode to use.
 * Returns 'ssh' if SSH fleet is configured, 'docker' otherwise.
 */
export function detectRuntimeMode(): RuntimeMode {
  return isFleetConfigured() ? 'ssh' : 'docker';
}
