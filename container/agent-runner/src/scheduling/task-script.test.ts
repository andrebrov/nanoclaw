import { describe, it, expect } from 'bun:test';
import { runScript } from './task-script.js';

describe('runScript requestId validation', () => {
  it('rejects task ids containing path traversal sequences', async () => {
    const result = await runScript('echo "test"', '../etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects task ids containing slashes', async () => {
    const result = await runScript('echo "test"', 'foo/bar');
    expect(result).toBeNull();
  });

  it('rejects task ids containing spaces', async () => {
    const result = await runScript('echo "test"', 'foo bar');
    expect(result).toBeNull();
  });

  it('rejects task ids containing special shell characters', async () => {
    const result = await runScript('echo "test"', 'foo;rm -rf /');
    expect(result).toBeNull();
  });

  it('accepts valid alphanumeric task ids with dashes', async () => {
    const script = 'echo \'{"wakeAgent":true}\'';
    const result = await runScript(script, 'task-1234-abc');
    expect(result).not.toBeNull();
    expect(result?.wakeAgent).toBe(true);
  });

  it('accepts valid task ids with underscores', async () => {
    const script = 'echo \'{"wakeAgent":false}\'';
    const result = await runScript(script, 'task_abc_123');
    expect(result?.wakeAgent).toBe(false);
  });
});
