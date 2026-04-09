/**
 * SSH pending credential request management.
 *
 * When an agent calls ssh_request_credential(mode:'ask') and the credential
 * doesn't exist, the alias + epoch_ms are recorded here. /ssh add checks
 * this file and sends an IPC notification when the credential is fulfilled.
 *
 * File: ~/.config/nanoclaw/credentials/{scope}/ssh.pending.json
 * Format: { alias: epoch_ms, ... }
 */
import path from 'path';

import { updateJsonFile } from '../token-substitute.js';
import { CREDENTIALS_DIR } from '../store.js';
import { logger } from '../../logger.js';
import type { GroupScope } from '../oauth-types.js';

// ── Constants ─────────────────────────────────────────────────────

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_CAP = 10;

type PendingFile = Record<string, number>;

// ── Helpers ───────────────────────────────────────────────────────

function pendingPath(scope: GroupScope): string {
  return path.join(CREDENTIALS_DIR, scope, 'ssh.pending.json');
}

function pruneStale(data: PendingFile): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const alias of Object.keys(data)) {
    if (data[alias] < cutoff) delete data[alias];
  }
}

// ── Public API ────────────────────────────────────────────────────

export interface AddPendingResult {
  /** Whether this request was accepted (vs suppressed). */
  accepted: boolean;
  /** Whether this request just hit the cap (notify user). */
  capReached: boolean;
}

/**
 * Add a pending SSH credential request.
 * Prunes stale entries first. Returns whether the request was accepted
 * and whether the cap was just reached.
 */
export function addPendingRequest(
  scope: GroupScope,
  alias: string,
): AddPendingResult {
  let accepted = false;
  let capReached = false;

  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);

    // Already pending for this alias
    if (data[alias] !== undefined) {
      accepted = true;
      return;
    }

    const count = Object.keys(data).length;
    if (count >= PENDING_CAP) {
      // At cap — silently drop
      logger.info({ alias, scope }, 'ssh.pending_suppressed');
      accepted = false;
      return;
    }

    data[alias] = Date.now();
    accepted = true;
    capReached = Object.keys(data).length >= PENDING_CAP;
  });

  return { accepted, capReached };
}

/**
 * Check if a pending request exists for an alias.
 * Prunes stale entries as a side effect.
 */
export function hasPendingRequest(scope: GroupScope, alias: string): boolean {
  let found = false;
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);
    found = data[alias] !== undefined;
  });
  return found;
}

/**
 * Remove a pending request for an alias (after fulfillment).
 * Returns true if the entry existed (and was removed).
 */
export function removePendingRequest(
  scope: GroupScope,
  alias: string,
): boolean {
  let existed = false;
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    pruneStale(data);
    if (data[alias] !== undefined) {
      existed = true;
      delete data[alias];
    }
  });
  return existed;
}

/**
 * Clear all pending requests for a scope.
 * Returns the number of entries cleared.
 */
export function clearAllPending(scope: GroupScope): number {
  let count = 0;
  updateJsonFile<PendingFile>(pendingPath(scope), (data) => {
    count = Object.keys(data).length;
    for (const k of Object.keys(data)) delete data[k];
  });
  return count;
}
