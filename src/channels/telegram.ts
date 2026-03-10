import fs from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { processInboundMedia } from '../media.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MediaSendOptions,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle media messages with processInboundMedia for lazy download
    const storeMedia = (
      ctx: any,
      opts: { fileId: string; mimetype: string; filename?: string; size?: number; mediaType: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      const result = processInboundMedia(group.folder, {
        channel: 'telegram',
        mimetype: opts.mimetype,
        filename: opts.filename,
        size: opts.size,
        sender: ctx.from?.id?.toString() || '',
        timestamp,
        ref: { fileId: opts.fileId }, // Telegram file_id for downloadMedia
        caption: ctx.message.caption,
        mediaType: opts.mediaType,
      });

      if (!result) return;

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: result.content,
        timestamp,
        is_from_me: false,
        attachments: result.attachments,
      });
    };

    this.bot.on('message:photo', (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      storeMedia(ctx, {
        fileId: largest.file_id,
        mimetype: 'image/jpeg',
        size: largest.file_size,
        mediaType: 'image',
      });
    });
    this.bot.on('message:video', (ctx) => {
      const v = ctx.message.video;
      storeMedia(ctx, {
        fileId: v.file_id,
        mimetype: v.mime_type || 'video/mp4',
        filename: v.file_name,
        size: v.file_size,
        mediaType: 'video',
      });
    });
    this.bot.on('message:voice', (ctx) => {
      const v = ctx.message.voice;
      storeMedia(ctx, {
        fileId: v.file_id,
        mimetype: v.mime_type || 'audio/ogg',
        size: v.file_size,
        mediaType: 'voice',
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const a = ctx.message.audio;
      storeMedia(ctx, {
        fileId: a.file_id,
        mimetype: a.mime_type || 'audio/mpeg',
        filename: a.file_name,
        size: a.file_size,
        mediaType: 'audio',
      });
    });
    this.bot.on('message:document', (ctx) => {
      const d = ctx.message.document;
      storeMedia(ctx, {
        fileId: d.file_id,
        mimetype: d.mime_type || 'application/octet-stream',
        filename: d.file_name,
        size: d.file_size,
        mediaType: 'document',
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const s = ctx.message.sticker;
      storeMedia(ctx, {
        fileId: s.file_id,
        mimetype: s.is_animated ? 'application/x-tgsticker' : 'image/webp',
        size: s.file_size,
        mediaType: 'sticker',
      });
    });
    // Location and contact don't have downloadable files — keep as placeholders
    this.bot.on('message:location', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', ctx.chat.type !== 'private');
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Location]',
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:contact', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', ctx.chat.type !== 'private');
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Contact]',
        timestamp,
        is_from_me: false,
      });
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendMedia(jid: string, filePath: string, options?: MediaSendOptions): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const file = new InputFile(fs.createReadStream(filePath), options?.filename || path.basename(filePath));
      const mime = options?.mimetype || '';
      const caption = options?.caption;

      if (mime.startsWith('image/')) {
        await this.bot.api.sendPhoto(numericId, file, { caption });
      } else if (mime.startsWith('video/')) {
        await this.bot.api.sendVideo(numericId, file, { caption });
      } else if (mime.startsWith('audio/') || mime === 'application/ogg') {
        await this.bot.api.sendAudio(numericId, file, { caption });
      } else {
        await this.bot.api.sendDocument(numericId, file, { caption });
      }
      logger.info({ jid, filePath }, 'Telegram media sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram media');
    }
  }

  async downloadMedia(ref: unknown): Promise<Buffer> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const { fileId } = ref as { fileId: string };
    const file = await this.bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
