/**
 * Chat-emoji module — per-messaging-group emoji mode toggle from chat.
 *
 * Registers the `set_chat_emoji` delivery action so admin agents can enable,
 * disable, or reset emoji for a specific chat without host-side CLI access.
 *
 * Security: the requesting session's agent group must have isAdmin=true in its
 * container.json. Non-admin containers cannot register the tool (gated in
 * mcp-tools/index.ts); the host re-validates here as defense-in-depth.
 *
 * No container restart needed — emoji_mode is stamped onto each turn's
 * overrides by the router at routing time. The change takes effect on the
 * next inbound message after the action is applied.
 */
import { getAllAgentGroups, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupByPlatform, setMessagingGroupEmojiMode } from '../../db/messaging-groups.js';
import { readContainerConfig } from '../../container-config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';
import type { Session } from '../../types.js';

const VALID_MODES = new Set(['auto', 'on', 'off']);

registerDeliveryAction('set_chat_emoji', async (content: Record<string, unknown>, session: Session) => {
  const callerGroup = getAgentGroupByFolder(
    getAllAgentGroups().find((g) => g.id === session.agent_group_id)?.folder ?? '',
  );
  if (!callerGroup) {
    log.warn('set_chat_emoji: requesting agent group not found', { agentGroupId: session.agent_group_id });
    notifyAgent(session, 'set_chat_emoji failed: requesting agent group not found.');
    return;
  }
  const callerConfig = readContainerConfig(callerGroup.folder);
  if (!callerConfig.isAdmin) {
    log.warn('set_chat_emoji: non-admin agent attempted emoji mode change', {
      agentGroupId: session.agent_group_id,
      folder: callerGroup.folder,
    });
    notifyAgent(session, 'Permission denied: set_chat_emoji is restricted to admin agent groups.');
    return;
  }

  const mode = (content.mode as string | undefined)?.trim();
  const channelType = (content.channelType as string | undefined)?.trim();
  const platformId = (content.platformId as string | undefined)?.trim();

  if (!mode || !VALID_MODES.has(mode)) {
    notifyAgent(session, `set_chat_emoji failed: mode must be one of "auto", "on", or "off".`);
    return;
  }
  if (!channelType || !platformId) {
    notifyAgent(session, 'set_chat_emoji failed: channelType and platformId are required.');
    return;
  }

  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    notifyAgent(session, `set_chat_emoji failed: no messaging group found for ${channelType}/${platformId}.`);
    return;
  }

  const previousMode = mg.emoji_mode ?? 'auto';
  setMessagingGroupEmojiMode(mg.id, mode as 'auto' | 'on' | 'off');

  log.info('set_chat_emoji applied', {
    messagingGroupId: mg.id,
    channelType,
    platformId,
    previousMode,
    newMode: mode,
    requestedBy: session.agent_group_id,
  });

  notifyAgent(
    session,
    `Emoji mode updated for chat "${mg.name ?? platformId}": ${previousMode} → ${mode}. Takes effect on the next message.`,
  );
});
