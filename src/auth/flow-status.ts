/**
 * OAuth flow status registry.
 *
 * Receives callbacks from queue mutations and OAuth progress events.
 * Provides per-flow SSE endpoints for observability.
 *
 * Separate from the queue — the queue manages ordering and delivery,
 * the registry tracks status and serves it to subscribers.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────────────

export type FlowEventType = 'queued' | 'active' | 'completed' | 'failed' | 'removed';

export interface FlowEvent {
  type: FlowEventType;
  providerId: string;
  explanation: string;
  timestamp: number;
}

interface FlowState {
  events: FlowEvent[];
  subscribers: Set<ServerResponse>;
}

// ── FlowStatusRegistry ─────────────────────────────────────────────

export class FlowStatusRegistry {
  private flows = new Map<string, FlowState>();

  /** Emit an event for a flow. Creates the flow state if it doesn't exist. */
  emit(flowId: string, providerId: string, type: FlowEventType, explanation: string): void {
    let state = this.flows.get(flowId);
    if (!state) {
      state = { events: [], subscribers: new Set() };
      this.flows.set(flowId, state);
    }

    const event: FlowEvent = { type, providerId, explanation, timestamp: Date.now() };
    state.events.push(event);

    // Broadcast to SSE subscribers
    const sseData = JSON.stringify({ providerId, explanation });
    for (const res of state.subscribers) {
      try {
        res.write(`event: ${type}\ndata: ${sseData}\n\n`);
      } catch {
        state.subscribers.delete(res);
      }
    }

    logger.debug({ flowId, type, providerId, explanation }, 'Flow status event');
  }

  /** Get current state for a flow (latest event type). */
  currentState(flowId: string): FlowEventType | null {
    const state = this.flows.get(flowId);
    if (!state || state.events.length === 0) return null;
    return state.events[state.events.length - 1].type;
  }

  /** Get all events for a flow. */
  events(flowId: string): FlowEvent[] {
    return this.flows.get(flowId)?.events ?? [];
  }

  /** List all tracked flow IDs with their current state. */
  listFlows(): Array<{ flowId: string; state: FlowEventType; providerId: string }> {
    const result: Array<{ flowId: string; state: FlowEventType; providerId: string }> = [];
    for (const [flowId, flowState] of this.flows) {
      if (flowState.events.length > 0) {
        const last = flowState.events[flowState.events.length - 1];
        result.push({ flowId, state: last.type, providerId: last.providerId });
      }
    }
    return result;
  }

  /**
   * Handle SSE subscription: GET /auth/flow/{flowId}/events
   *
   * Replays current state on connect, then streams live events.
   */
  handleSSE(flowId: string, _req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    let state = this.flows.get(flowId);
    if (!state) {
      state = { events: [], subscribers: new Set() };
      this.flows.set(flowId, state);
    }

    // Replay existing events
    for (const event of state.events) {
      const sseData = JSON.stringify({ providerId: event.providerId, explanation: event.explanation });
      res.write(`event: ${event.type}\ndata: ${sseData}\n\n`);
    }

    state.subscribers.add(res);

    res.on('close', () => {
      state!.subscribers.delete(res);
    });
  }

  /**
   * Handle flow list: GET /auth/flows
   *
   * Returns JSON array of all flows with their current state.
   */
  handleListFlows(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(this.listFlows()));
  }

  /** Clean up — close all SSE connections. */
  destroy(): void {
    for (const [, state] of this.flows) {
      for (const res of state.subscribers) {
        try { res.end(); } catch { /* ignore */ }
      }
      state.subscribers.clear();
    }
    this.flows.clear();
  }
}
