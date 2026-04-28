import { describe, it, expect, vi, afterEach } from 'vitest';

import { resolveAgentModel } from './agent-model.js';

vi.mock('./log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAgentModel', () => {
  it('returns undefined when AGENT_MODEL is not set', () => {
    expect(resolveAgentModel({})).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(resolveAgentModel({ AGENT_MODEL: '' })).toBeUndefined();
  });

  it('returns undefined for whitespace-only value', () => {
    expect(resolveAgentModel({ AGENT_MODEL: '   ' })).toBeUndefined();
  });

  it('returns model string for known claude- prefix', () => {
    expect(resolveAgentModel({ AGENT_MODEL: 'claude-sonnet-4-6[1m]' })).toBe('claude-sonnet-4-6[1m]');
  });

  it('trims whitespace from a valid model string', () => {
    expect(resolveAgentModel({ AGENT_MODEL: '  claude-opus-4-7  ' })).toBe('claude-opus-4-7');
  });

  it('returns value and warns for unrecognized prefix', async () => {
    const { log } = await import('./log.js');
    const result = resolveAgentModel({ AGENT_MODEL: 'gpt-4o' });
    expect(result).toBe('gpt-4o');
    expect(log.warn).toHaveBeenCalledWith('AGENT_MODEL has unrecognized prefix — forwarding anyway', {
      model: 'gpt-4o',
    });
  });
});
