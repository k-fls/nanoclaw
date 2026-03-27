import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  NEW_GROUPS_USE_DEFAULT_CREDENTIALS,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { initCredentialStore, importEnvToDefault, createAuthGuard, registerBuiltinProviders, registerDiscoveryProviders, getTokenEngine } from './auth/index.js';
import { createAccessCheck } from './auth/provision.js';
import { claudeProvider, extractUpstreamRequestId } from './auth/providers/claude.js';
import type { ChatIO } from './auth/types.js';
import { AsyncMutex } from './auth/async-mutex.js';
import { createSessionContext } from './auth/session-context.js';
import { consumeFlows } from './auth/flow-consumer.js';
import { setAuthErrorResolver, setOAuthInitiationResolver } from './auth/universal-oauth-handler.js';
import { setBrowserOpenCallback } from './auth/browser-open-handler.js';
import { CredentialProxy, setProxyInstance, getProxy, setProxyResponseHook } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup, scopeOf } from './types.js';
import type { TokenSubstituteEngine } from './auth/token-substitute.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/** Shared token engine — set during startup, used by runtime code. */
let tokenEngine: TokenSubstituteEngine;

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  // Apply global default for useDefaultCredentials if not explicitly set
  if (group.containerConfig?.useDefaultCredentials === undefined) {
    group.containerConfig = {
      ...group.containerConfig,
      useDefaultCredentials: NEW_GROUPS_USE_DEFAULT_CREDENTIALS,
    };
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** Create a ChatIO that routes through the normal channel messaging. */
function createChatIO(channel: Channel, chatJid: string): ChatIO {
  let lastReceivedTs: string | null = null;
  return {
    async send(text: string): Promise<void> {
      await channel.sendMessage(chatJid, text);
    },
    async sendRaw(text: string): Promise<void> {
      await channel.sendMessage(chatJid, text);
    },
    async receive(timeoutMs = 120_000): Promise<string | null> {
      const start = Date.now();
      const cursor = getMessagesSince(chatJid, '', ASSISTANT_NAME);
      const lastTs = cursor.length > 0 ? cursor[cursor.length - 1].timestamp : '';
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));
        const newer = getMessagesSince(chatJid, lastTs, ASSISTANT_NAME);
        if (newer.length > 0) {
          lastReceivedTs = newer[0].timestamp;
          return newer[0].content;
        }
      }
      return null;
    },
    advanceCursor(): void {
      if (lastReceivedTs) {
        lastAgentTimestamp[chatJid] = lastReceivedTs;
        saveState();
      }
    },
  };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Create per-session context for auth error correlation and flow queue
  const scope = scopeOf(group);
  const sessionCtx = createSessionContext(scope, extractUpstreamRequestId);
  const chatLock = new AsyncMutex();
  const flowAbort = new AbortController();

  // Register session context with proxy for auth error callbacks and SSE
  const proxy = getProxy();
  proxy.registerSessionContext(scope, sessionCtx);

  // Start FIFO flow queue consumer
  const consumerPromise = consumeFlows(
    sessionCtx.flowQueue,
    chatLock,
    createChatIO(channel, chatJid),
    sessionCtx.statusRegistry,
    flowAbort.signal,
  );

  const guard = createAuthGuard(
    group,
    () => createChatIO(channel, chatJid),
    () => queue.closeStdin(chatJid),
    claudeProvider,
    sessionCtx.pendingErrors,
  );
  const credentialsOk = await guard.preCheck();

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // If reauth failed, advance cursor so trigger messages don't re-trigger
  if (!credentialsOk) {
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const lastOriginalTs = missedMessages[missedMessages.length - 1].timestamp;
  lastAgentTimestamp[chatJid] = lastOriginalTs;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const agentResult = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await chatLock.acquire();
        try {
          await channel.sendMessage(chatJid, text);
        } finally {
          chatLock.release();
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    queue.notifyIdle(chatJid);
    if (result.status === 'error') {
      hadError = true;
    }
    guard.onStreamResult(result);
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Step 5-6: Cancel consumer and await clean exit before handleAuthError
  flowAbort.abort();
  await consumerPromise;

  if (agentResult.status === 'error' || hadError) {
    const authResult = await guard.handleAuthError(agentResult.error);

    // Step 8: Cleanup session context
    proxy.deregisterSessionContext(scope);
    sessionCtx.statusRegistry.destroy();

    if (authResult === 'reauth-failed') return true;
    if (authResult === 'reauth-ok') {
      // If reauth consumed messages (advanceCursor moved past original), don't retry
      if (lastAgentTimestamp[chatJid] !== lastOriginalTs) return true;
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      return false;
    }

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Step 8: Cleanup session context (success path)
  proxy.deregisterSessionContext(scope);
  sessionCtx.statusRegistry.destroy();

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      tokenEngine,
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initCredentialStore();

  // Create and initialize the credential proxy instance.
  // Must happen before registerProvider() calls so providers can register host rules.
  const proxy = new CredentialProxy();
  setProxyInstance(proxy);

  // Activate proxy tap logger if PROXY_TAP_DOMAIN + PROXY_TAP_PATH are set
  const { createTapFilterFromEnv } = await import('./proxy-tap-logger.js');
  const tapFilter = createTapFilterFromEnv();
  if (tapFilter) proxy.setTapFilter(tapFilter);

  // Register built-in auth providers first (takes priority in first-match dispatch),
  // then discovery-file providers to fill gaps for other OAuth services.
  registerBuiltinProviders();
  registerDiscoveryProviders();

  // Wire token engine with group resolver and access check.
  // Must happen after providers are registered and before any provision calls.
  {
    const engine = tokenEngine = getTokenEngine();
    engine.setGroupResolver((folder) => {
      for (const g of Object.values(registeredGroups)) {
        if (g.folder === folder) return g;
      }
      return undefined;
    });
    engine.setAccessCheck(createAccessCheck((folder) => {
      for (const g of Object.values(registeredGroups)) {
        if (g.folder === folder) return g;
      }
      return undefined;
    }));
  }

  // Import .env credentials after engine is ready (migration runs inside getTokenEngine)
  importEnvToDefault(tokenEngine);

  // Wire auth error resolver: bearer-swap handler looks up session context by scope
  setAuthErrorResolver((scope) => {
    const ctx = proxy.getSessionContext(scope);
    return ctx?.onAuthError ?? null;
  });

  // Shared logic: parse an OAuth authorization URL, build a FlowEntry, push to queue.
  /** Parse an OAuth authorization URL, build a FlowEntry, push to queue. Returns the flowId. */
  function pushOAuthFlow(
    ctx: import('./auth/session-context.js').ContainerSessionContext,
    url: string,
    containerIP: string,
    providerId: string,
    reason: string,
  ): string {
    // Extract redirect_uri and check if it targets localhost
    let callbackPort: number | null = null;
    let callbackPath = '/callback';
    let isLocalhost = false;
    // providerId comes from the matched authorization pattern (browser-open handler)
    // or the authorize-stub handler (proxy interception) — always a real provider ID.

    // flowId format: providerId:callbackPort:stateHash
    //   callbackPort = localhost port or 0 for non-localhost
    //   stateHash = first 8 chars of base64url(sha256(oauth state param))
    let flowId: string;
    try {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      if (redirectUri) {
        const redirectUrl = new URL(redirectUri);
        const host = redirectUrl.hostname;
        isLocalhost = host === 'localhost'
          || host === '127.0.0.1'
          || host === '[::1]'
          || host === '::1';
        if (isLocalhost) {
          callbackPort = parseInt(redirectUrl.port, 10) || null;
          callbackPath = redirectUrl.pathname || '/callback';
        }
      }
      const state = parsed.searchParams.get('state') || url;
      const stateHash = crypto.createHash('sha256')
        .update(state).digest('base64url').slice(0, 8);
      flowId = `${providerId}:${callbackPort || 0}:${stateHash}`;
    } catch (err) {
      logger.warn({ err, providerId, url }, 'Failed to parse OAuth URL for flowId');
      flowId = `${providerId}:0:${Date.now()}`;
    }

    // Build deliveryFn only for localhost callbacks — non-localhost redirects
    // are handled by the OAuth provider directly (browser redirect), no
    // programmatic delivery possible.
    let deliveryFn: import('./auth/flow-queue.js').DeliveryFn | null = null;
    if (isLocalhost && callbackPort && containerIP) {
      const port = callbackPort;
      const cbPath = callbackPath;
      const ip = containerIP;
      deliveryFn = async (reply: string) => {
        const code = encodeURIComponent(reply);
        // Container bridge IP — bracket-wrap if IPv6 for URL compatibility.
        const host = ip.includes(':') ? `[${ip}]` : ip;
        const callbackUrl = `http://${host}:${port}${cbPath}?code=${code}`;
        try {
          const res = await fetch(callbackUrl, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            return { ok: true };
          }
          return { ok: false, error: `callback returned ${res.status}` };
        } catch (err) {
          // ECONNREFUSED, timeout, etc — container may be dead
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };
    }

    ctx.flowQueue.push({ flowId, providerId, url, deliveryFn }, reason);
    return flowId;
  }

  // Wire OAuth initiation resolver: authorize-stub handler pushes to session's flow queue
  setOAuthInitiationResolver((eventScope) => {
    const ctx = proxy.getSessionContext(eventScope);
    if (!ctx) return null;
    return (authUrl: string, providerId: string, containerIP: string) => {
      pushOAuthFlow(ctx, authUrl, containerIP, providerId, 'proxy intercepted authorization endpoint');
    };
  });

  // Wire browser-open callback: xdg-open shim pushes to session's flow queue.
  // Returns flowId so the handler can include it in the HTTP response to the shim.
  setBrowserOpenCallback(({ url, scope: eventScope, containerIP, providerId }) => {
    const ctx = proxy.getSessionContext(eventScope);
    if (!ctx) {
      logger.warn({ scope: eventScope }, 'browser-open: no session context for scope');
      return null;
    }
    return pushOAuthFlow(ctx, url, containerIP, providerId, 'xdg-open shim detected OAuth URL');
  });

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Register additional Claude hosts from ANTHROPIC_BASE_URL if configured
  {
    const envVars = await import('./env.js').then(m => m.readEnvFile(['ANTHROPIC_BASE_URL']));
    if (envVars.ANTHROPIC_BASE_URL) {
      const { registerClaudeBaseUrl } = await import('./auth/providers/claude.js');
      const { createHandler } = await import('./auth/universal-oauth-handler.js');
      const { getTokenEngine } = await import('./auth/registry.js');
      registerClaudeBaseUrl(envVars.ANTHROPIC_BASE_URL, getTokenEngine(), createHandler);
    }
  }

  // Start credential proxy — handles transparent TLS (iptables redirect),
  // explicit HTTP/HTTPS proxy (CONNECT), and internal endpoints.
  const proxyServer = await proxy.start({
    port: CREDENTIAL_PROXY_PORT,
    host: PROXY_BIND_HOST,
    enableTransparent: true,
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    tokenEngine,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
