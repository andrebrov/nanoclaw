/**
 * Channel-model module — operator-controlled per-group model overrides from chat.
 *
 * Registers the `set_group_model` delivery action so admin agents can change
 * a target group's Claude model from inside any chat (e.g. from a DM with Main).
 *
 * Security: the requesting session's agent group must have isAdmin=true in its
 * container.json. Non-admin containers cannot even register the tool (gated in
 * mcp-tools/index.ts), and the host re-validates here as defense-in-depth.
 *
 * No approval step is needed — only admin-flagged containers can invoke the
 * action, and the operator is explicitly making the request from their own DM.
 */
import { getAllAgentGroups, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { readContainerConfig, updateContainerConfig } from '../../container-config.js';
import { killContainer } from '../../container-runner.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';
import type { Session } from '../../types.js';

// claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5-20251001, etc.
const MODEL_RE = /^claude-[a-z0-9]+-[0-9]/;

registerDeliveryAction('set_group_model', async (content: Record<string, unknown>, session: Session) => {
  // Defense-in-depth: verify the requesting agent group has isAdmin=true.
  const callerGroup = getAgentGroupByFolder(
    getAllAgentGroups().find((g) => g.id === session.agent_group_id)?.folder ?? '',
  );
  if (!callerGroup) {
    log.warn('set_group_model: requesting agent group not found', { agentGroupId: session.agent_group_id });
    notifyAgent(session, 'set_group_model failed: requesting agent group not found.');
    return;
  }
  const callerConfig = readContainerConfig(callerGroup.folder);
  if (!callerConfig.isAdmin) {
    log.warn('set_group_model: non-admin agent attempted model change', {
      agentGroupId: session.agent_group_id,
      folder: callerGroup.folder,
    });
    notifyAgent(session, 'Permission denied: set_group_model is restricted to admin agent groups.');
    return;
  }

  const targetFolder = (content.group as string | undefined)?.trim();
  const newModel = (content.model as string | null | undefined) ?? null;

  if (!targetFolder) {
    notifyAgent(session, 'set_group_model failed: group is required.');
    return;
  }
  if (newModel && !MODEL_RE.test(newModel)) {
    notifyAgent(
      session,
      `set_group_model failed: invalid model ID "${newModel}". Expected a Claude model ID starting with "claude-" (e.g. claude-sonnet-4-6).`,
    );
    return;
  }

  const targetGroup = getAgentGroupByFolder(targetFolder);
  if (!targetGroup) {
    // Try a case-insensitive match on name
    const allGroups = getAllAgentGroups();
    const byName = allGroups.find((g) => g.name.toLowerCase() === targetFolder.toLowerCase());
    if (!byName) {
      const groupList = allGroups.map((g) => `${g.name} (${g.folder})`).join(', ');
      notifyAgent(
        session,
        `set_group_model failed: no agent group with folder "${targetFolder}". Known groups: ${groupList || '(none)'}`,
      );
      return;
    }
    // fall through using byName
    return applyModelChange(session, byName, newModel);
  }

  return applyModelChange(session, targetGroup, newModel);
});

async function applyModelChange(
  session: Session,
  targetGroup: { id: string; name: string; folder: string },
  newModel: string | null,
): Promise<void> {
  const currentConfig = readContainerConfig(targetGroup.folder);
  const previousModel = currentConfig.model ?? null;

  updateContainerConfig(targetGroup.folder, (cfg) => {
    if (newModel) {
      cfg.model = newModel;
    } else {
      delete cfg.model;
    }
  });

  log.info('set_group_model applied', {
    targetGroup: targetGroup.folder,
    previousModel,
    newModel,
    requestedBy: session.agent_group_id,
  });

  // Kill all running sessions for the target group so the next message picks up
  // the new model. The host sweep will respawn them automatically.
  const sessions = getSessionsByAgentGroup(targetGroup.id);
  let killedCount = 0;
  for (const s of sessions) {
    killContainer(s.id, `model changed to ${newModel ?? '(default)'}`);
    killedCount++;
  }

  const prevLabel = previousModel ?? '(default)';
  const newLabel = newModel ?? '(default)';
  const restartNote =
    killedCount > 0
      ? ` ${killedCount} container(s) restarted — the new model takes effect on the next message.`
      : ' No running containers to restart; change takes effect on next startup.';

  notifyAgent(
    session,
    `Model updated for "${targetGroup.name}" (${targetGroup.folder}): ${prevLabel} → ${newLabel}.${restartNote}`,
  );
}
