/**
 * Flow status registry.
 *
 * Receives callbacks from queue mutations and event progress.
 * Provides per-flow SSE endpoints for observability.
 *
 * Separate from the queue — the queue manages ordering and delivery,
 * the registry tracks status and serves it to subscribers.
 */
import type { IncomingMessage, ServerResponse } from 'http';

import type { FlowEventKind } from './flow-queue.js';
import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────────────

export type FlowState =
  | 'queued'
  | 'active'
  | 'completed'
  | 'failed'
  | 'removed';

export interface FlowEvent {
  state: FlowState;
  eventType: FlowEventKind;
  explanation: string;
  timestamp: number;
}

interface FlowRecord {
  events: FlowEvent[];
  subscribers: Set<ServerResponse>;
}

// ── FlowStatusRegistry ─────────────────────────────────────────────

export class FlowStatusRegistry {
  private flows = new Map<string, FlowRecord>();

  /** Emit an event for a flow. Creates the flow state if it doesn't exist. */
  emit(
    flowId: string,
    eventType: FlowEventKind,
    state: FlowState,
    explanation: string,
  ): void {
    let flowState = this.flows.get(flowId);
    if (!flowState) {
      flowState = { events: [], subscribers: new Set() };
      this.flows.set(flowId, flowState);
    }

    const event: FlowEvent = {
      state,
      eventType,
      explanation,
      timestamp: Date.now(),
    };
    flowState.events.push(event);

    // Broadcast to SSE subscribers
    const sseData = JSON.stringify({ eventType, explanation });
    for (const res of flowState.subscribers) {
      try {
        res.write(`event: ${state}\ndata: ${sseData}\n\n`);
      } catch {
        flowState.subscribers.delete(res);
      }
    }

    logger.debug(
      { flowId, state, eventType, explanation },
      'Flow status event',
    );
  }

  /** Get current state for a flow (latest event state). */
  currentState(flowId: string): FlowState | null {
    const flowState = this.flows.get(flowId);
    if (!flowState || flowState.events.length === 0) return null;
    return flowState.events[flowState.events.length - 1].state;
  }

  /** Get all events for a flow. */
  events(flowId: string): FlowEvent[] {
    return this.flows.get(flowId)?.events ?? [];
  }

  /** List all tracked flow IDs with their current state. */
  listFlows(): Array<{
    flowId: string;
    state: FlowState;
    eventType: string;
  }> {
    const result: Array<{
      flowId: string;
      state: FlowState;
      eventType: string;
    }> = [];
    for (const [flowId, flowState] of this.flows) {
      if (flowState.events.length > 0) {
        const last = flowState.events[flowState.events.length - 1];
        result.push({ flowId, state: last.state, eventType: last.eventType });
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
      connection: 'keep-alive',
    });

    let flowState = this.flows.get(flowId);
    if (!flowState) {
      flowState = { events: [], subscribers: new Set() };
      this.flows.set(flowId, flowState);
    }

    // Replay existing events
    for (const event of flowState.events) {
      const sseData = JSON.stringify({
        eventType: event.eventType,
        explanation: event.explanation,
      });
      res.write(`event: ${event.state}\ndata: ${sseData}\n\n`);
    }

    flowState.subscribers.add(res);

    res.on('close', () => {
      flowState!.subscribers.delete(res);
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
    for (const [, flowState] of this.flows) {
      for (const res of flowState.subscribers) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      flowState.subscribers.clear();
    }
    this.flows.clear();
  }
}
