/**
 * Regression test: add_reaction must appear in the MCP server's ListTools response.
 *
 * Verifies acceptance criterion #1 from issue #21: the tool must be discoverable
 * by any MCP client that queries the nanoclaw server — not just callable by name.
 * Uses an in-memory transport so no stdio or subprocess is needed.
 */
import { describe, it, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Import tool modules to trigger their registerTools() side-effect calls.
// This mirrors what mcp-tools/index.ts does before startMcpServer().
import './core.js';

import { createMcpServer } from './server.js';

describe('MCP server ListTools', () => {
  it('exposes add_reaction alongside the other core tools', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('add_reaction');
    expect(names).toContain('send_message');
    expect(names).toContain('send_file');
    expect(names).toContain('edit_message');

    await client.close();
    await server.close();
  });

  it('add_reaction schema requires messageId (integer) and emoji (string)', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'add_reaction');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(['messageId', 'emoji']);
    expect((tool!.inputSchema.properties as Record<string, { type: string }>)['messageId'].type).toBe('integer');
    expect((tool!.inputSchema.properties as Record<string, { type: string }>)['emoji'].type).toBe('string');

    await client.close();
    await server.close();
  });
});
