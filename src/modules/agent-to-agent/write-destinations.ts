/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import fs from 'fs';

import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { getDestinations, normalizeName } from './db/agent-destinations.js';

export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const rows = getDestinations(agentGroupId);
  const resolved: DestinationRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  // Track names claimed so far so synthetic injections never collide with
  // explicit destinations. The destinations table has UNIQUE(name); if an
  // operator already pointed `main` at a specific agent (or `broadcast` at
  // a specific channel), respect that and skip the synthetic with the same
  // name — explicit user wiring wins.
  const usedNames = new Set(resolved.map((r) => r.name));

  // Synthetic broadcast destination — fan out to all peers via
  // send_message({ to: 'broadcast' }). Routed by agent-route.ts using
  // the '__broadcast__' sentinel id.
  if (!usedNames.has('broadcast')) {
    resolved.push({
      name: 'broadcast',
      display_name: 'All Agents',
      type: 'agent',
      channel_type: null,
      platform_id: null,
      agent_group_id: '__broadcast__',
    });
    usedNames.add('broadcast');
  }

  // Synthetic main destination — reach the user's primary DM agent (oldest
  // group by created_at) without operator wiring. Routed by agent-route.ts
  // using the '__main__' sentinel id.
  if (!usedNames.has('main')) {
    resolved.push({
      name: 'main',
      display_name: 'Main Agent',
      type: 'agent',
      channel_type: null,
      platform_id: null,
      agent_group_id: '__main__',
    });
    usedNames.add('main');
  }

  // Synthetic peer destinations — inject every other agent group so agents
  // can reach peers by name (e.g. send_message({ to: 'researcher', ... }))
  // without the operator having to manually wire destinations.
  for (const ag of getAllAgentGroups()) {
    if (ag.id === agentGroupId) continue;
    const peerName = normalizeName(ag.name);
    if (usedNames.has(peerName)) continue;
    usedNames.add(peerName);
    resolved.push({
      name: peerName,
      display_name: ag.name,
      type: 'agent',
      channel_type: null,
      platform_id: null,
      agent_group_id: ag.id,
    });
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceDestinations(db, resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
