import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    let body = escapeXml(m.content);
    if (m.attachments?.length) {
      const atts = m.attachments.map((att) => {
        const sizeAttr = att.size != null ? ` size="${att.size}"` : '';
        return `\n<attachment id="${escapeXml(att.id)}" name="${escapeXml(att.filename)}" type="${escapeXml(att.mimetype)}"${sizeAttr} />`;
      });
      body += atts.join('');
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${body}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Fallback Slack decoder for compatibility with older slack channel code
 * that doesn't implement decodeInbound yet. Handles entities, URLs, and
 * mentions but cannot resolve bot mention → trigger (needs bot user ID).
 */
function fallbackSlackDecode(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<@(U[A-Z0-9]+)>/g, '@$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Decode channel-specific encoding from stored messages (e.g. Slack entities). */
export function decodeMessages(
  msgs: NewMessage[],
  channel: Channel,
): NewMessage[] {
  let decode = channel.decodeInbound?.bind(channel);
  if (!decode && channel.name === 'slack') {
    decode = fallbackSlackDecode;
  }
  if (!decode) return msgs;
  return msgs.map((m) => ({ ...m, content: decode(m.content) }));
}
