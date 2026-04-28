/**
 * Pattern + extraction tests for the LinkedIn post validator.
 *
 * `evaluatePost` is intentionally not exercised here — it spawns the claude
 * CLI and would require a stub binary. The fail-open contract from the spec
 * guarantees that any failure on that path is benign. What matters for the
 * gate's correctness is that we identify the right Bash commands and pull
 * out the right text from them.
 */
import { describe, it, expect } from 'bun:test';

import { extractPostText, isLinkedInPostCommand } from './linkedin-post-validator.js';

describe('isLinkedInPostCommand', () => {
  it('matches composio-tool linkedin-create-post', () => {
    expect(isLinkedInPostCommand('composio-tool linkedin-create-post --text "hi"')).toBe(true);
  });

  it('matches composio-tool linkedin-create-linked-in-post', () => {
    expect(isLinkedInPostCommand('composio-tool linkedin-create-linked-in-post --text "hi"')).toBe(true);
  });

  it('matches composio-tool linkedin post-share (subcommand variant)', () => {
    expect(isLinkedInPostCommand('composio-tool linkedin post-share "draft body"')).toBe(true);
  });

  it('matches heyreach-tool post-share', () => {
    expect(isLinkedInPostCommand('heyreach-tool post-share --content "abc"')).toBe(true);
  });

  it('does NOT match composio-tool gmail send', () => {
    expect(isLinkedInPostCommand('composio-tool gmail send "subject" "body" finsi')).toBe(false);
  });

  it('does NOT match composio-tool attio update', () => {
    expect(isLinkedInPostCommand('composio-tool attio update people abc123 \'{"name":"x"}\'')).toBe(false);
  });

  it('does NOT match plain Bash like ls', () => {
    expect(isLinkedInPostCommand('ls -la /tmp')).toBe(false);
  });

  it('does NOT match a string that merely contains the word linkedin', () => {
    expect(isLinkedInPostCommand('echo "I love linkedin"')).toBe(false);
  });
});

describe('extractPostText', () => {
  it('pulls the value of --text', () => {
    const t = extractPostText('composio-tool linkedin-create-post --text "Hello world"');
    expect(t).toBe('Hello world');
  });

  it('pulls the value of --commentary', () => {
    const t = extractPostText('composio-tool linkedin-create-post --commentary "Insightful take"');
    expect(t).toBe('Insightful take');
  });

  it('pulls the value of --content (single-quoted)', () => {
    const t = extractPostText("heyreach-tool post-share --content 'single quoted body'");
    expect(t).toBe('single quoted body');
  });

  it('handles --text=value form', () => {
    const t = extractPostText('composio-tool linkedin-create-post --text="equals form"');
    expect(t).toBe('equals form');
  });

  it('falls back to the last quoted positional arg', () => {
    const t = extractPostText('composio-tool linkedin post-share "first arg" "actual post text"');
    expect(t).toBe('actual post text');
  });

  it('unescapes embedded quotes', () => {
    const t = extractPostText('composio-tool linkedin-create-post --text "she said \\"hi\\" loud"');
    expect(t).toBe('she said "hi" loud');
  });

  it('returns null when nothing quoted is present', () => {
    expect(extractPostText('composio-tool linkedin post-share')).toBeNull();
  });
});
