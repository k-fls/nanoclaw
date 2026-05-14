/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * - Wake containers for sessions with due messages (process_after)
 * - Detect stale processing messages (container crash) → reset with backoff
 * - Insert next occurrence for recurring messages
 * - Kill idle containers past timeout
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { openSessionDb, sessionDbPath } from './session-manager.js';
import { wakeContainer, isContainerRunning } from './container-runner-v2.js';
import type { Session } from './types-v2.js';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const dbPath = sessionDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(dbPath)) return;

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  } catch {
    return;
  }

  try {
    // 1. Check for due pending messages → wake container
    const dueMessages = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR process_after <= datetime('now'))`,
      )
      .get() as { count: number };

    if (dueMessages.count > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueMessages.count });
      await wakeContainer(session);
    }

    // 2. Detect stale processing messages
    const staleMessages = db
      .prepare(
        `SELECT id, tries FROM messages_in
         WHERE status = 'processing'
           AND status_changed < datetime('now', '-${Math.floor(STALE_THRESHOLD_MS / 1000)} seconds')`,
      )
      .all() as Array<{ id: string; tries: number }>;

    for (const msg of staleMessages) {
      if (msg.tries >= MAX_TRIES) {
        db.prepare("UPDATE messages_in SET status = 'failed', status_changed = datetime('now') WHERE id = ?").run(
          msg.id,
        );
        log.warn('Message marked as failed after max retries', { messageId: msg.id, sessionId: session.id });
      } else {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
        const backoffSec = Math.floor(backoffMs / 1000);
        db.prepare(
          `UPDATE messages_in SET status = 'pending', status_changed = datetime('now'), process_after = datetime('now', '+${backoffSec} seconds') WHERE id = ?`,
        ).run(msg.id);
        log.info('Reset stale message with backoff', { messageId: msg.id, tries: msg.tries, backoffMs });
      }
    }

    // 3. Handle recurrence for completed messages
    const completedRecurring = db
      .prepare("SELECT * FROM messages_in WHERE status = 'completed' AND recurrence IS NOT NULL")
      .all() as Array<{
      id: string;
      kind: string;
      content: string;
      recurrence: string;
      process_after: string | null;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
    }>;

    for (const msg of completedRecurring) {
      try {
        // Dynamic import to avoid loading cron-parser at module level
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(msg.recurrence);
        const nextRun = interval.next().toISOString();
        const newId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Compute next seq from both tables (same pattern as session-manager.ts)
        const nextSeq = (
          db
            .prepare(
              `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM (
                 SELECT seq FROM messages_in WHERE seq IS NOT NULL
                 UNION ALL
                 SELECT seq FROM messages_out WHERE seq IS NOT NULL
               )`,
            )
            .get() as { next: number }
        ).next;

        db.prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, platform_id, channel_type, thread_id, content)
           VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId,
          nextSeq,
          msg.kind,
          nextRun,
          msg.recurrence,
          msg.platform_id,
          msg.channel_type,
          msg.thread_id,
          msg.content,
        );

        // Remove recurrence from the completed message so it doesn't spawn again
        db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(msg.id);

        log.info('Inserted next recurrence', { originalId: msg.id, newId, nextRun });
      } catch (err) {
        log.error('Failed to compute next recurrence', { messageId: msg.id, recurrence: msg.recurrence, err });
      }
    }
  } finally {
    db.close();
  }
}
