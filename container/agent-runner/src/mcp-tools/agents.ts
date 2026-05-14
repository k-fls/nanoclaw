/**
 * Agent-to-agent MCP tools: send_to_agent.
 */
import { writeMessageOut } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const sendToAgent: McpToolDefinition = {
  tool: {
    name: 'send_to_agent',
    description: 'Send a message to another agent group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentGroupId: { type: 'string', description: 'Target agent group ID' },
        text: { type: 'string', description: 'Message content' },
        sessionId: { type: 'string', description: 'Target specific session (optional)' },
      },
      required: ['agentGroupId', 'text'],
    },
  },
  async handler(args) {
    const agentGroupId = args.agentGroupId as string;
    const text = args.text as string;
    if (!agentGroupId || !text) return err('agentGroupId and text are required');

    const id = generateId();

    writeMessageOut({
      id,
      kind: 'chat',
      channel_type: 'agent',
      platform_id: agentGroupId,
      thread_id: (args.sessionId as string) || null,
      content: JSON.stringify({ text }),
    });

    log(`send_to_agent: ${id} → ${agentGroupId}`);
    return ok(`Message sent to agent ${agentGroupId} (id: ${id})`);
  },
};

export const agentTools: McpToolDefinition[] = [sendToAgent];
