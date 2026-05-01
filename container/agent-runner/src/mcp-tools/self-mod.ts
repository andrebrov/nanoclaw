/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
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

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config. For local process servers provide `command` + `args`. For remote HTTP/SSE servers (e.g. `https://mcp.granola.ai/mcp`) provide `url` and optionally `type` ("http" or "sse", default "http"), `headers`, and `oauth` for OAuth 2.0 auth. Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: {
          type: 'string',
          description: 'Command to run a local stdio MCP server (e.g. `npx @modelcontextprotocol/server-github`)',
        },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (local servers only)' },
        env: { type: 'object', description: 'Environment variables for local servers' },
        url: { type: 'string', description: 'URL of a remote HTTP or SSE MCP server' },
        type: {
          type: 'string',
          enum: ['http', 'sse'],
          description: 'Transport type for remote servers: "http" (Streamable HTTP, default) or "sse"',
        },
        headers: { type: 'object', description: 'Static HTTP headers for remote servers (e.g. {"X-Api-Key": "..."})' },
        oauth: {
          type: 'object',
          description:
            'OAuth 2.0 config for servers that require bearer-token auth. The agent-runner acquires and refreshes tokens transparently — no manual header management needed.',
          properties: {
            tokenUrl: { type: 'string', description: 'Token endpoint URL' },
            grantType: {
              type: 'string',
              enum: ['client_credentials', 'refresh_token'],
              description: '"client_credentials" for machine-to-machine; "refresh_token" for user-delegated access',
            },
            clientId: { type: 'string', description: 'OAuth client ID' },
            clientSecret: {
              type: 'string',
              description: 'OAuth client secret (client_credentials or confidential-client refresh)',
            },
            refreshToken: { type: 'string', description: 'Refresh token (refresh_token grant only)' },
            scope: { type: 'string', description: 'Space-separated OAuth scope (optional)' },
          },
          required: ['tokenUrl', 'grantType', 'clientId'],
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string | undefined;
    const url = args.url as string | undefined;
    if (!name) return err('name is required');
    if (!command && !url) return err('either command (for local servers) or url (for remote servers) is required');

    const requestId = generateId();
    if (url) {
      const type = (args.type as string) || 'http';
      if (type !== 'http' && type !== 'sse') return err('type must be "http" or "sse"');
      const oauth = args.oauth as Record<string, string> | undefined;
      if (oauth) {
        if (!oauth.tokenUrl) return err('oauth.tokenUrl is required');
        if (!oauth.grantType) return err('oauth.grantType is required');
        if (!oauth.clientId) return err('oauth.clientId is required');
        if (oauth.grantType !== 'client_credentials' && oauth.grantType !== 'refresh_token')
          return err('oauth.grantType must be "client_credentials" or "refresh_token"');
        if (oauth.grantType === 'refresh_token' && !oauth.refreshToken)
          return err('oauth.refreshToken is required for refresh_token grant');
      }
      writeMessageOut({
        id: requestId,
        kind: 'system',
        content: JSON.stringify({
          action: 'add_mcp_server',
          name,
          url,
          type,
          headers: (args.headers as Record<string, string>) || {},
          ...(oauth ? { oauth } : {}),
        }),
      });
      log(`add_mcp_server: ${requestId} → "${name}" (${url})${oauth ? ` [oauth:${oauth.grantType}]` : ''}`);
    } else {
      writeMessageOut({
        id: requestId,
        kind: 'system',
        content: JSON.stringify({
          action: 'add_mcp_server',
          name,
          command: command!,
          args: (args.args as string[]) || [],
          env: (args.env as Record<string, string>) || {},
        }),
      });
      log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    }
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
