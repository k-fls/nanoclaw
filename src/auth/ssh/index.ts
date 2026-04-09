/**
 * SSH subsystem — public API.
 *
 * Non-SSH code should only import from this barrel.
 */
export { initSSHSystem, getSSHManager } from './init.js';
export { socketDir } from './manager.js';
export type { SSHManager } from './manager.js';
