import { describe, it, expect, beforeEach } from 'bun:test';

import { newIdleGeneration, resetIdleTimer, clearIdleTimer, _getGeneration } from './idle-timer.js';

// Bun doesn't have vi.useFakeTimers, but setTimeout is fast enough at 1 ms
// for these unit tests.

beforeEach(() => {
  // Reset module state before each test by starting a fresh generation.
  clearIdleTimer();
  // Force a fresh generation so each test starts clean.
  newIdleGeneration();
});

describe('idle-timer', () => {
  it('fires the callback after the timeout', async () => {
    let fired = false;
    resetIdleTimer(() => {
      fired = true;
    }, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(true);
  });

  it('cancels the previous timer when reset is called again', async () => {
    let count = 0;
    resetIdleTimer(() => count++, 20);
    // Reset before first timer fires
    resetIdleTimer(() => count++, 20);
    await new Promise((r) => setTimeout(r, 60));
    // Only the second timer should have fired
    expect(count).toBe(1);
  });

  it('clearIdleTimer prevents the callback from firing', async () => {
    let fired = false;
    resetIdleTimer(() => {
      fired = true;
    }, 10);
    clearIdleTimer();
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
  });

  it('newIdleGeneration cancels in-flight timer (cross-query guard)', async () => {
    let gen1Fired = false;
    const gen1 = _getGeneration();

    resetIdleTimer(() => {
      gen1Fired = true;
    }, 20);

    // Simulate a new processQuery starting before the timer fires
    newIdleGeneration();
    const gen2 = _getGeneration();
    expect(gen2).toBe(gen1 + 1);

    await new Promise((r) => setTimeout(r, 50));

    // The timer registered against gen1 must NOT have fired
    expect(gen1Fired).toBe(false);
  });

  it('timer from previous generation does not fire after new generation starts', async () => {
    const fired: string[] = [];

    // Generation 1 timer
    resetIdleTimer(() => fired.push('gen1'), 20);

    // Advance generation (simulates next processQuery)
    newIdleGeneration();

    // Generation 2 timer — longer window
    resetIdleTimer(() => fired.push('gen2'), 40);

    await new Promise((r) => setTimeout(r, 80));

    expect(fired).not.toContain('gen1');
    expect(fired).toContain('gen2');
  });

  it('clearIdleTimer in finally does not affect subsequent newIdleGeneration', async () => {
    resetIdleTimer(() => {}, 10);
    clearIdleTimer(); // processQuery finally block

    // Next processQuery starts
    newIdleGeneration();
    let fired = false;
    resetIdleTimer(() => {
      fired = true;
    }, 10);

    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(true);
  });
});
