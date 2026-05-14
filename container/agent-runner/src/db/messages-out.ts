import { getSessionDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/** Write a new outbound message, auto-assigning a seq number. */
export function writeMessageOut(msg: WriteMessageOut): number {
  const db = getSessionDb();
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
    `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, delivered, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES (@id, @seq, @in_reply_to, datetime('now'), 0, @deliver_after, @recurrence, @kind, @platform_id, @channel_type, @thread_id, @content)`,
  ).run({
    in_reply_to: null,
    deliver_after: null,
    recurrence: null,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    ...msg,
    seq: nextSeq,
  });

  return nextSeq;
}

/** Look up a message's platform ID by seq number. */
export function getMessageIdBySeq(seq: number): string | null {
  const inRow = getSessionDb().prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (inRow) return inRow.id;
  const outRow = getSessionDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as { id: string } | undefined;
  return outRow?.id ?? null;
}

/** Get undelivered messages (for host polling). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getSessionDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE delivered = 0
         AND (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}

/** Mark a message as delivered. */
export function markDelivered(id: string): void {
  getSessionDb().prepare('UPDATE messages_out SET delivered = 1 WHERE id = ?').run(id);
}
