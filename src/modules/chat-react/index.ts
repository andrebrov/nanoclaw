/**
 * Chat-react module — per-messaging-group react_on_wake toggle from chat.
 *
 * Registers the `set_chat_react` delivery action so admin agents can enable
 * or disable the host-driven 👀 reaction on wake for a specific chat without
 * host-side CLI access.
 *
 * Security: the requesting session's agent group must have isAdmin=true in its
 * container.json. Non-admin containers cannot register the tool (gated in
 * mcp-tools/index.ts); the host re-validates here as defense-in-depth.
 *
 * No container restart needed — react_on_wake is read by the router at
 * routing time. The change takes effect on the next inbound message after
 * the action is applied.
 */
import { getAllAgentGroups, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupByPlatform, setMessagingGroupReactOnWake } from '../../db/messaging-groups.js';
import { readContainerConfig } from '../../container-config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';
import type { Session } from '../../types.js';

registerDeliveryAction('set_chat_react', async (content: Record<string, unknown>, session: Session) => {
  const callerGroup = getAgentGroupByFolder(
    getAllAgentGroups().find((g) => g.id === session.agent_group_id)?.folder ?? '',
  );
  if (!callerGroup) {
    log.warn('set_chat_react: requesting agent group not found', { agentGroupId: session.agent_group_id });
    notifyAgent(session, 'set_chat_react failed: requesting agent group not found.');
    return;
  }
  const callerConfig = readContainerConfig(callerGroup.folder);
  if (!callerConfig.isAdmin) {
    log.warn('set_chat_react: non-admin agent attempted react_on_wake change', {
      agentGroupId: session.agent_group_id,
      folder: callerGroup.folder,
    });
    notifyAgent(session, 'Permission denied: set_chat_react is restricted to admin agent groups.');
    return;
  }

  const enabled = content.enabled;
  const channelType = (content.channelType as string | undefined)?.trim();
  const platformId = (content.platformId as string | undefined)?.trim();

  if (typeof enabled !== 'boolean') {
    notifyAgent(session, 'set_chat_react failed: enabled must be a boolean (true or false).');
    return;
  }
  if (!channelType || !platformId) {
    notifyAgent(session, 'set_chat_react failed: channelType and platformId are required.');
    return;
  }

  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    notifyAgent(session, `set_chat_react failed: no messaging group found for ${channelType}/${platformId}.`);
    return;
  }

  const previous = (mg.react_on_wake ?? 1) !== 0;
  setMessagingGroupReactOnWake(mg.id, enabled);

  log.info('set_chat_react applied', {
    messagingGroupId: mg.id,
    channelType,
    platformId,
    previous,
    enabled,
    requestedBy: session.agent_group_id,
  });

  notifyAgent(
    session,
    `React-on-wake updated for chat "${mg.name ?? platformId}": ${previous ? 'on' : 'off'} → ${enabled ? 'on' : 'off'}. Takes effect on the next message.`,
  );
});
