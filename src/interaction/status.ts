/**
 * Interaction status registry.
 *
 * Receives callbacks from queue mutations and event progress.
 * Provides per-interaction SSE endpoints for observability.
 *
 * Separate from the queue — the queue manages ordering and delivery,
 * the registry tracks status and serves it to subscribers.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import type { InteractionEventKind } from './queue.js';
import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────────────

export type InteractionState =
  | 'queued'
  | 'active'
  | 'completed'
  | 'failed'
  | 'removed';

export interface InteractionEvent {
  state: InteractionState;
  eventType: InteractionEventKind;
  explanation: string;
  timestamp: number;
}

interface InteractionRecord {
  events: InteractionEvent[];
  subscribers: Set<ServerResponse>;
}

// ── InteractionStatusRegistry ───────────────────────────────────────

export class InteractionStatusRegistry {
  private interactions = new Map<string, InteractionRecord>();

  /** Emit an event for an interaction. Creates state if it doesn't exist. */
  emit(
    interactionId: string,
    eventType: InteractionEventKind,
    state: InteractionState,
    explanation: string,
  ): void {
    let record = this.interactions.get(interactionId);
    if (!record) {
      record = { events: [], subscribers: new Set() };
      this.interactions.set(interactionId, record);
    }

    const event: InteractionEvent = {
      state,
      eventType,
      explanation,
      timestamp: Date.now(),
    };
    record.events.push(event);

    // Broadcast to SSE subscribers
    const sseData = JSON.stringify({ eventType, explanation });
    for (const res of record.subscribers) {
      try {
        res.write(`event: ${state}\ndata: ${sseData}\n\n`);
      } catch {
        record.subscribers.delete(res);
      }
    }

    logger.debug(
      { interactionId, state, eventType, explanation },
      'Interaction status event',
    );
  }

  /** Get current state for an interaction (latest event state). */
  currentState(interactionId: string): InteractionState | null {
    const record = this.interactions.get(interactionId);
    if (!record || record.events.length === 0) return null;
    return record.events[record.events.length - 1].state;
  }

  /** Get all events for an interaction. */
  events(interactionId: string): InteractionEvent[] {
    return this.interactions.get(interactionId)?.events ?? [];
  }

  /** List all tracked interaction IDs with their current state. */
  listInteractions(): Array<{
    interactionId: string;
    state: InteractionState;
    eventType: string;
  }> {
    const result: Array<{
      interactionId: string;
      state: InteractionState;
      eventType: string;
    }> = [];
    for (const [interactionId, record] of this.interactions) {
      if (record.events.length > 0) {
        const last = record.events[record.events.length - 1];
        result.push({
          interactionId,
          state: last.state,
          eventType: last.eventType,
        });
      }
    }
    return result;
  }

  /**
   * Handle SSE subscription: GET /interaction/{interactionId}/events
   *
   * Replays current state on connect, then streams live events.
   */
  handleSSE(
    interactionId: string,
    _req: IncomingMessage,
    res: ServerResponse,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let record = this.interactions.get(interactionId);
    if (!record) {
      record = { events: [], subscribers: new Set() };
      this.interactions.set(interactionId, record);
    }

    // Replay existing events
    for (const event of record.events) {
      const sseData = JSON.stringify({
        eventType: event.eventType,
        explanation: event.explanation,
      });
      res.write(`event: ${event.state}\ndata: ${sseData}\n\n`);
    }

    record.subscribers.add(res);

    res.on('close', () => {
      record!.subscribers.delete(res);
    });
  }

  /**
   * Handle interaction list: GET /interactions
   *
   * Returns JSON array of all interactions with their current state.
   */
  handleListInteractions(
    _req: IncomingMessage,
    res: ServerResponse,
  ): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(this.listInteractions()));
  }

  /** Clean up — close all SSE connections. */
  destroy(): void {
    for (const [, record] of this.interactions) {
      for (const res of record.subscribers) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      record.subscribers.clear();
    }
    this.interactions.clear();
  }
}
