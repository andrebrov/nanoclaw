/**
 * Container-side secret files for v1-style skill scripts.
 *
 * v1 agent-runner wrote `/tmp/.composio-credentials`, `/tmp/.attio-api-key`,
 * etc. inside the container so bash scripts (composio-tool, instantly-tool,
 * phantombuster-tool) could read API keys without env-var leakage. v2 moved
 * to OneCLI Agent Vault for raw API keys, but the routing identifiers
 * (entity_id, connection IDs) and tool keys are still consumed by these
 * scripts in the container. Without this layer, every Composio-mediated
 * skill (Gmail, Calendar, Attio, LinkedIn, etc.) errors with
 * "Composio credentials not available" at startup.
 *
 * Writes files into a per-session `.secrets/` dir on the host so we can
 * bind-mount them into the container at the paths the scripts expect.
 * Files are mode 0o600. The OneCLI proxy still rewrites the actual
 * `x-api-key` / `Authorization` headers on outbound requests — the
 * api_key value in the creds file is effectively a placeholder once the
 * vault is configured.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const COMPOSIO_KEY_MAP: Record<string, string> = {
  COMPOSIO_API_KEY: 'api_key',
  COMPOSIO_ENTITY_ID: 'entity_id',
  COMPOSIO_GMAIL_FINSI_CONN_ID: 'gmail_finsi',
  COMPOSIO_GMAIL_PERSONAL_CONN_ID: 'gmail_personal',
  COMPOSIO_CALENDAR_FINSI_CONN_ID: 'calendar_finsi',
  COMPOSIO_CALENDAR_PERSONAL_CONN_ID: 'calendar_personal',
  COMPOSIO_ATTIO_CONN_ID: 'attio',
  COMPOSIO_LINKEDIN_CONN_ID: 'linkedin',
  COMPOSIO_TWITTER_CONN_ID: 'twitter',
  COMPOSIO_GOOGLESHEETS_CONN_ID: 'googlesheets',
  GHOST_API_URL: 'ghost_api_url',
  GHOST_ADMIN_API_KEY: 'ghost_admin_api_key',
  GHOST_CONTENT_API_KEY: 'ghost_content_api_key',
};

const ENTITY_OVERRIDE_MAP: Record<string, string> = {
  COMPOSIO_ATTIO_ENTITY: 'attio',
  COMPOSIO_LINKEDIN_ENTITY: 'linkedin',
  COMPOSIO_GMAIL_FINSI_ENTITY: 'gmail_finsi',
  COMPOSIO_TWITTER_ENTITY: 'twitter',
};

export interface SecretsMount {
  hostPath: string;
  containerPath: string;
  readonly: true;
}

/**
 * Write per-session secrets files and return their bind-mount entries.
 * Returns an empty array if no relevant env vars are set (no Composio etc.
 * configured — nothing to mount, scripts will exit cleanly with their own
 * "credentials not available" message).
 */
export function writeSessionSecrets(sessionDir: string): SecretsMount[] {
  const allKeys = [
    ...Object.keys(COMPOSIO_KEY_MAP),
    ...Object.keys(ENTITY_OVERRIDE_MAP),
    'COMPOSIO_PERSONAL_ENTITY_ID',
    'ATTIO_API_KEY',
    'INSTANTLY_API_KEY',
    'PHANTOMBUSTER_API_KEY',
  ];
  const env = readEnvFile(allKeys);

  const secretsDir = path.join(sessionDir, '.secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  const mounts: SecretsMount[] = [];

  // Composio creds
  const composioCreds: Record<string, string | Record<string, string>> = {};
  for (const [envKey, jsonKey] of Object.entries(COMPOSIO_KEY_MAP)) {
    if (env[envKey]) composioCreds[jsonKey] = env[envKey];
  }
  const entityOverrides: Record<string, string> = {};
  if (env['COMPOSIO_PERSONAL_ENTITY_ID']) {
    entityOverrides['gmail_personal'] = env['COMPOSIO_PERSONAL_ENTITY_ID'];
    entityOverrides['calendar_personal'] = env['COMPOSIO_PERSONAL_ENTITY_ID'];
  }
  for (const [envKey, connKey] of Object.entries(ENTITY_OVERRIDE_MAP)) {
    if (env[envKey]) entityOverrides[connKey] = env[envKey];
  }
  if (Object.keys(entityOverrides).length > 0) {
    composioCreds['entity_overrides'] = entityOverrides;
  }
  if (Object.keys(composioCreds).length > 0) {
    const p = path.join(secretsDir, 'composio-credentials');
    fs.writeFileSync(p, JSON.stringify(composioCreds), { mode: 0o600 });
    mounts.push({ hostPath: p, containerPath: '/tmp/.composio-credentials', readonly: true });
  }

  if (env['ATTIO_API_KEY']) {
    const p = path.join(secretsDir, 'attio-api-key');
    fs.writeFileSync(p, env['ATTIO_API_KEY'], { mode: 0o600 });
    mounts.push({ hostPath: p, containerPath: '/tmp/.attio-api-key', readonly: true });
  }

  if (env['INSTANTLY_API_KEY']) {
    const p = path.join(secretsDir, 'instantly-credentials');
    fs.writeFileSync(p, JSON.stringify({ api_key: env['INSTANTLY_API_KEY'] }), { mode: 0o600 });
    mounts.push({ hostPath: p, containerPath: '/tmp/.instantly-credentials', readonly: true });
  }

  if (env['PHANTOMBUSTER_API_KEY']) {
    const p = path.join(secretsDir, 'phantombuster-credentials');
    fs.writeFileSync(p, JSON.stringify({ api_key: env['PHANTOMBUSTER_API_KEY'] }), { mode: 0o600 });
    mounts.push({ hostPath: p, containerPath: '/tmp/.phantombuster-credentials', readonly: true });
  }

  // /tmp/.env: dump every non-bookkeeping host .env entry so Python skill
  // scripts using `load_dotenv()` / `os.getenv()` work out of the box.
  // This is the v1 contract that broke when v2 moved to OneCLI Vault —
  // restoring it here keeps existing skills (clay/email_finder.py,
  // assistant/*, etc.) functional. The OneCLI proxy still handles the
  // actual credential injection on outbound HTTPS, so values written
  // here are belt-and-suspenders for HTTPS calls and the only source of
  // truth for non-HTTPS uses (webhook URLs, Meta SDKs, OAuth flows).
  //
  // Excluded keys: NanoClaw infra (TELEGRAM_BOT_TOKEN — already injected
  // via host adapter, never used inside agent containers), runtime
  // toggles (TELEGRAM_ONLY, TZ, INSTALL_CJK_FONTS, etc.), the OneCLI
  // bridge config, ANTHROPIC_API_KEY (Claude SDK gets it from OneCLI),
  // and the bot pool token list.
  const dotenvExcludePatterns = [
    /^TELEGRAM_/, // bot token + per-bot pool — host-side only
    /^TZ$/,
    /^TIMEZONE$/,
    /^NODE_ENV$/,
    /^LOG_LEVEL$/,
    /^CONTAINER_(IMAGE|RUNTIME)/,
    /^GROUPS_DIR$/,
    /^DATA_DIR$/,
    /^INSTALL_CJK_FONTS$/,
    /^ONECLI_(URL|API_KEY)$/, // host's OneCLI auth — agent uses its own agent token
    /^ANTHROPIC_API_KEY$/, // Claude SDK gets this via OneCLI proxy injection
    /^ASSISTANT_NAME$/, // host-supplied per agent group
  ];
  const fullEnv = readFullDotenv();
  const dotenvLines: string[] = [];
  for (const [key, value] of Object.entries(fullEnv)) {
    if (dotenvExcludePatterns.some((re) => re.test(key))) continue;
    if (!value) continue;
    dotenvLines.push(`${key}=${value}`);
  }
  if (dotenvLines.length > 0) {
    const p = path.join(secretsDir, 'env');
    fs.writeFileSync(p, dotenvLines.join('\n') + '\n', { mode: 0o600 });
    mounts.push({ hostPath: p, containerPath: '/tmp/.env', readonly: true });
  }

  if (mounts.length > 0) {
    log.debug('Container secrets files written', { sessionDir, count: mounts.length });
  }
  return mounts;
}

/**
 * Read every key=value line from the host `.env` (without the keys-list
 * filter that `readEnvFile` imposes). Used only here for the
 * `/tmp/.env` dump — host-side processes should keep using
 * `readEnvFile([allowed-keys])` so the contract stays narrow.
 */
function readFullDotenv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const result: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return result;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
