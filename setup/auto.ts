/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|timezone|channel|
 *                           verify|first-chat)
 *
 * Timezone is auto-detected after the CLI agent step. UTC resolves are
 * confirmed with the user, and free-text replies fall through to a
 * headless `claude -p` call for IANA-zone resolution.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import * as os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { BACK_TO_CHANNEL_SELECTION } from './lib/back-nav.js';
import { runDiscordChannel } from './channels/discord.js';
import { runTeamsChannel } from './channels/teams.js';
import { runTelegramChannel } from './channels/telegram.js';
import { runWhatsAppChannel } from './channels/whatsapp.js';
import { pingCliAgent, type PingResult } from './lib/agent-ping.js';
import { brightSelect } from './lib/bright-select.js';
import { offerClaudeOnFailure } from './lib/claude-handoff.js';
import {
  applyToEnv,
  parseFlags,
  printHelp,
  readFromEnv,
} from './lib/setup-config-parse.js';
import { runAdvancedScreen } from './lib/setup-config-screen.js';
import { runWindowedStep } from './lib/windowed-runner.js';
import { detectRegisteredGroups, detectExistingDisplayName } from './environment.js';
import { pollHealth } from './onecli.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { claudeCliAvailable, resolveTimezoneViaClaude } from './lib/tz-from-claude.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietChild, runQuietStep, spawnQuiet } from './lib/runner.js';
import { emit as phEmit } from './lib/diagnostics.js';
import { accentGreen, brandBody, brandBold, brandChip, dimWrap, fitToWidth, fmtDuration, note, wrapForGutter } from './lib/theme.js';
import { isValidTimezone } from '../src/timezone.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();

type ChannelChoice = 'telegram' | 'discord' | 'whatsapp' | 'signal' | 'teams' | 'slack' | 'imessage' | 'other' | 'skip';

async function main(): Promise<void> {
  // Make sure ~/.local/bin is on PATH for every child process we spawn.
  // Installers we run mid-setup (OneCLI, claude) drop binaries there and
  // append a PATH line to the user's shell rc, but rc updates don't reach
  // an already-running Node process — so without this patch a freshly
  // installed `onecli` is invisible to a subsequent `runInheritScript`.
  ensureLocalBinOnPath();

  // Parse CLI flags first — `--help` short-circuits before we render anything,
  // and flag values get folded into process.env so existing step code reading
  // NANOCLAW_* sees them unchanged.
  const flagResult = parseFlags(process.argv.slice(2));
  if (flagResult.help) {
    printHelp();
    process.exit(0);
  }
  if (flagResult.errors.length > 0) {
    for (const err of flagResult.errors) console.error(`error: ${err}`);
    console.error('');
    console.error('Run with --help for the full list of supported flags.');
    process.exit(1);
  }
  let configValues = { ...readFromEnv(), ...flagResult.values };
  applyToEnv(configValues);

  printIntro();
  initProgressionLog();
  phEmit('auto_started');

  // Welcome menu — default path or open advanced overrides before any setup
  // work begins. Default lands on standard so Enter is the happy path.
  // On sg re-exec, the user already chose — skip straight to standard.
  let startChoice: 'default' | 'advanced' = 'default';
  if (process.env.NANOCLAW_REEXEC_SG !== '1') {
    startChoice = ensureAnswer(
      await brightSelect<'default' | 'advanced'>({
        message: 'How would you like to begin?',
        options: [
          { value: 'default', label: 'Standard setup' },
          { value: 'advanced', label: 'Advanced', hint: 'override defaults' },
        ],
        initialValue: 'default',
      }),
    ) as 'default' | 'advanced';
    setupLog.userInput('start_choice', startChoice);
  }
  if (startChoice === 'advanced') {
    configValues = await runAdvancedScreen(configValues);
    applyToEnv(configValues);
  }

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking your system…',
      done: 'Your system looks good.',
    });
    if (!res.ok) {
      await fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
      );
    }
  }

  if (!skip.has('container')) {
    p.log.message(dimWrap('Your assistant lives in its own sandbox. It can only see what you explicitly share.', 4));
    const res = await runQuietStep('container', {
      running: "Preparing your assistant's sandbox…",
      done: 'Sandbox ready.',
      failed: "Couldn't prepare the sandbox.",
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        await fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        await fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      await fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    p.log.message(
      dimWrap(
        'Your assistant never gets your API keys directly. The vault adds them to approved requests as they leave the sandbox.',
        4,
      ),
    );
    const res = await runQuietStep('onecli', {
      running: "Setting up OneCLI, your agent's vault…",
      done: 'OneCLI vault ready.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'onecli_not_on_path_after_install') {
        await fail(
          'onecli',
          'OneCLI was installed but your shell needs to refresh to see it.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      await fail(
        'onecli',
        `Couldn't set up OneCLI (${err ?? 'unknown error'}).`,
        'Make sure curl is installed and ~/.local/bin is writable, then retry.',
      );
    }
  }

  if (!skip.has('auth')) {
    await runAuthStep();
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
    );
    if (!res.ok) {
      await fail('mounts', "Couldn't write access rules.");
    }
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Starting NanoClaw in the background…',
      done: 'NanoClaw is running.',
    });
    if (!res.ok) {
      await fail('service', "Couldn't start NanoClaw.", 'See logs/nanoclaw.error.log for details.');
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn("NanoClaw's permissions need a tweak before it can reach Docker.");
      p.log.message(
        k.dim('  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' + '  systemctl --user restart nanoclaw'),
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent') && detectRegisteredGroups(process.cwd())) {
    skip.add('cli-agent');
    skip.add('first-chat');
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Bringing your assistant online…',
        done: 'Assistant wired up.',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME, '--folder', '_ping-test'],
    );
    if (!res.ok) {
      await fail(
        'cli-agent',
        "Couldn't bring your assistant online.",
        `You can retry later with \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\`.`,
      );
    }
    if (!skip.has('first-chat')) {
      const ping = await confirmAssistantResponds();
      if (ping === 'ok') {
        phEmit('first_chat_ready');
        const cleanupRawLog = setupLog.stepRawLog('cleanup-cli-agent');
        const cleanupStart = Date.now();
        const cleanup = await spawnQuiet(
          'pnpm',
          ['exec', 'tsx', 'scripts/delete-cli-agent.ts', '--folder', '_ping-test'],
          cleanupRawLog,
        );
        setupLog.step(
          'cleanup-cli-agent',
          cleanup.ok ? 'success' : 'failed',
          Date.now() - cleanupStart,
          { exit_code: cleanup.exitCode },
          cleanupRawLog,
        );
        if (!cleanup.ok) {
          p.log.warn(
            brandBody(
              `Couldn't clean up the test agent — it may still appear in your agent list. See ${cleanupRawLog} for details.`,
            ),
          );
        }
        const next = ensureAnswer(
          await brightSelect<'continue' | 'chat'>({
            message: 'What next?',
            options: [
              {
                value: 'continue',
                label: 'Continue with setup',
                hint: 'recommended',
              },
              {
                value: 'chat',
                label: 'Pause here and chat with your agent from the terminal',
              },
            ],
          }),
        ) as 'continue' | 'chat';
        setupLog.userInput('first_chat_choice', next);
        if (next === 'chat') {
          const terminalAgentName = `${displayName!}'s Terminal`;
          const createRes = await runQuietChild(
            'create-terminal-agent',
            'pnpm',
            ['exec', 'tsx', 'scripts/init-cli-agent.ts', '--display-name', displayName!, '--agent-name', terminalAgentName],
            { running: `Creating ${terminalAgentName}…`, done: `${terminalAgentName} is ready.` },
          );
          if (!createRes.ok) {
            await fail(
              'create-terminal-agent',
              `Couldn't create ${terminalAgentName}.`,
              'You can retry later with `pnpm exec tsx scripts/init-cli-agent.ts`.',
            );
          }
          await runFirstChat();
        }
      } else {
        phEmit('first_chat_failed', { reason: ping });
        renderPingFailureNote(ping);
        await offerClaudeOnFailure({
          stepName: 'cli-agent',
          msg:
            ping === 'socket_error'
              ? "NanoClaw service isn't listening on its CLI socket."
              : 'No reply from the assistant within 30 seconds.',
          hint:
            ping === 'socket_error'
              ? 'Socket at data/cli.sock did not accept a connection.'
              : 'Agent container may be failing to start or authenticate.',
        });
      }
    }
  }

  if (!skip.has('timezone')) {
    await runTimezoneStep();
  }

  // v1 → v2 migration is handled by `bash migrate-v2.sh`, not the setup flow.
  // Users migrating from v1 run that script before (or instead of) setup.

  let channelChoice: ChannelChoice = 'skip';

  if (!skip.has('channel')) {
    // Loop so a channel sub-flow can return BACK_TO_CHANNEL_SELECTION on
    // its first prompt and bounce the user back to the chooser without
    // restarting setup. Channels not yet wired with the back option just
    // return void and the loop exits after one pass.
    let backed = true;
    while (backed) {
      backed = false;
      channelChoice = await askChannelChoice();
      if (channelChoice !== 'skip' && channelChoice !== 'other') {
        await resolveDisplayName();
      }
      let result: void | typeof BACK_TO_CHANNEL_SELECTION;
      if (channelChoice === 'telegram') {
        result = await runTelegramChannel(displayName!);
      } else if (channelChoice === 'discord') {
        result = await runDiscordChannel(displayName!);
      } else if (channelChoice === 'whatsapp') {
        result = await runWhatsAppChannel(displayName!);
      } else if (channelChoice === 'signal') {
        result = await runSignalChannel(displayName!);
      } else if (channelChoice === 'teams') {
        result = await runTeamsChannel(displayName!);
      } else if (channelChoice === 'slack') {
        result = await runSlackChannel(displayName!);
      } else if (channelChoice === 'imessage') {
        result = await runIMessageChannel(displayName!);
      } else if (channelChoice === 'other') {
        result = await askOtherChannelName();
      } else {
        p.log.info(
          brandBody(
            wrapForGutter(
              'No messaging app for now. You can add one later (like Telegram, Discord, WhatsApp, Teams, Slack, or iMessage).',
              4,
            ),
          ),
        );
      }
      if (result === BACK_TO_CHANNEL_SELECTION) backed = true;
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Making sure everything works together…',
      done: "Everything's connected.",
      failed: 'A few things still need your attention.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push("• Your Claude account isn't connected. Re-run setup and try again.");
      }
      const service = res.terminal?.fields.SERVICE;
      if (service === 'running_other_checkout') {
        notes.push(
          wrapForGutter(
            [
              '• Your NanoClaw service is running from a different folder on this machine.',
              '  Point it at this checkout with:',
              '    launchctl bootout gui/$(id -u)/com.nanoclaw',
              '    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist',
            ].join('\n'),
            6,
          ),
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push(
          '• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.',
        );
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), "What's left");
      }
      // "What's left" is a soft failure — we don't abort like fail(), but the
      // user is still stuck and a fix is exactly what claude-assist is for.
      const summary = notes
        .map((n) => n.replace(/^•\s*/, '').split('\n')[0].trim())
        .filter(Boolean)
        .join(' · ');
      phEmit('setup_incomplete', {
        unresolved_count: notes.length,
        service_running: res.terminal?.fields.SERVICE === 'running',
        has_credentials: res.terminal?.fields.CREDENTIALS === 'configured',
      });
      await offerClaudeOnFailure({
        stepName: 'verify',
        msg: summary || 'Verification completed with unresolved issues.',
        hint: `Terminal block: ${JSON.stringify(res.terminal?.fields ?? {})}`,
        rawLogPath: res.rawLog,
      });
      p.outro(k.yellow('Almost there. A few things still need your attention.'));
      return;
    }
  }

  const rows: [string, string][] = [
    ['Chat in the terminal:', 'pnpm run chat hi'],
    ["See what's happening:", 'tail -f logs/nanoclaw.log'],
    ['Open Claude Code:', 'claude'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows.map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`).join('\n');
  p.note(nextSteps, 'Try these');
  setupLog.complete(Date.now() - RUN_START);
  phEmit('setup_completed', { duration_ms: Date.now() - RUN_START });
  p.outro(k.green("You're ready! Enjoy NanoClaw."));
}

// ─── first-chat step ───────────────────────────────────────────────────

/**
 * Round-trip ping against the CLI socket before we ask the user to chat.
 * Renders its own spinner with elapsed time because a cold-start container
 * boot can take 30–60s — the elapsed counter is the difference between
 * "patient" and "is this hung?". Returns the raw result so the caller can
 * branch between the chat loop (ok) and a diagnostic note (anything else).
 */
async function confirmAssistantResponds(): Promise<PingResult> {
  const s = p.spinner();
  const start = Date.now();
  const label = 'Waking your assistant…';
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const result = await pingCliAgent();

  clearInterval(tick);
  const suffix = ` (${fmtDuration(Date.now() - start)})`;
  if (result === 'ok') {
    s.stop(`${fitToWidth('Your assistant is ready.', suffix)}${k.dim(suffix)}`);
  } else {
    const msg =
      result === 'socket_error' ? "Couldn't reach the NanoClaw service." : "Your assistant didn't reply in time.";
    s.stop(`${fitToWidth(msg, suffix)}${k.dim(suffix)}`, 1);
  }
  return result;
}

function renderPingFailureNote(result: PingResult): void {
  const body =
    result === 'socket_error'
      ? [
          wrapForGutter(
            "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
            6,
          ),
          '',
          k.dim('  macOS:  launchctl kickstart -k gui/$(id -u)/com.nanoclaw'),
          k.dim('  Linux:  systemctl --user restart nanoclaw'),
        ].join('\n')
      : wrapForGutter(
          'No reply from your assistant within 30 seconds. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
          6,
        );
  p.note(body, 'Skipping the first chat');
}

/**
 * Chat loop. Each message is piped through `pnpm run chat`, which uses
 * the same Unix-socket path the ping just exercised, so output streams
 * back inline as the agent replies. An empty input ends the loop.
 */
async function runFirstChat(): Promise<void> {
  while (true) {
    const answer = ensureAnswer(
      await p.text({
        message: 'Say something to your assistant',
        placeholder: 'press Enter with nothing to continue',
      }),
    );
    const text = ((answer as string | undefined) ?? '').trim();
    if (!text) return;
    await sendChatMessage(text);
  }
}

function sendChatMessage(message: string): Promise<void> {
  return new Promise((resolve) => {
    // `pnpm --silent` suppresses the `> nanoclaw@… chat` preamble so the
    // agent's reply reads as a clean block under the prompt. Splitting on
    // whitespace mirrors `pnpm run chat hello world` — chat.ts joins argv
    // with spaces on the far side.
    const child = spawn('pnpm', ['--silent', 'run', 'chat', ...message.split(/\s+/)], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// ─── auth step (select → branch) ────────────────────────────────────────

async function runAuthStep(): Promise<void> {
  if (anthropicSecretExists()) {
    p.log.success('Your Claude account is already connected.');
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  const method = ensureAnswer(
    await p.select({
      message: 'How would you like to connect to Claude?',
      options: [
        {
          value: 'subscription',
          label: 'Sign in with my Claude subscription',
          hint: 'recommended if you have Pro or Max',
        },
        {
          value: 'oauth',
          label: 'Paste an OAuth token I already have',
          hint: 'sk-ant-oat…',
        },
        {
          value: 'api',
          label: 'Paste an Anthropic API key',
          hint: 'pay-per-use via console.anthropic.com',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'not recommended — Claude helps debug setup issues',
        },
      ],
    }),
  ) as 'subscription' | 'oauth' | 'api' | 'skip';
  setupLog.userInput('auth_method', method);
  phEmit('auth_method_chosen', { method });

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message:
          "Skip Claude sign-in? The agent won't be able to run until you connect, and we won't be able to help debug setup errors.",
        initialValue: false,
      }),
    );
    if (!confirmed) {
      // Loop back to the auth picker so they can choose a real method.
      return runAuthStep();
    }
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped' });
    p.log.warn(
      brandBody(
        'Claude sign-in skipped. Re-run setup or run `bash nanoclaw.sh` to finish later.',
      ),
    );
    return;
  }

  if (method === 'subscription') {
    await runSubscriptionAuth();
  } else {
    await runPasteAuth(method);
  }
}

function isHeadlessLinux(): boolean {
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

async function runSubscriptionAuth(): Promise<void> {
  p.log.step('Opening the Claude sign-in flow…');
  if (isHeadlessLinux()) {
    console.log(k.dim("   (no browser detected — you'll be prompted to paste a token from another machine)"));
  } else {
    console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  }
  console.log();
  const start = Date.now();
  const code = await runInheritScript('bash', ['setup/register-claude-token.sh']);
  const durationMs = Date.now() - start;
  console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    await fail(
      'auth',
      "Couldn't complete the Claude sign-in.",
      'Re-run setup and try again, or choose a paste option instead.',
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  p.log.success('Claude account connected.');
}

async function runPasteAuth(method: 'oauth' | 'api'): Promise<void> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';

  const answer = ensureAnswer(
    await p.password({
      message: `Paste your ${label}`,
      validate: (v) => {
        // Strip any internal whitespace so a line-wrapped paste that did
        // survive into clack can still validate. The mid-token-newline
        // case where clack only sees the first line is caught by the
        // shape check below.
        const cleaned = (v ?? '').replace(/\s+/g, '');
        if (!cleaned) return 'Required';
        if (!cleaned.startsWith(prefix)) {
          return `Should start with ${prefix}…`;
        }
        if (method === 'oauth' && !/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/.test(cleaned)) {
          return cleaned.length < 90
            ? 'Token looks truncated — line breaks in the paste can cut it off. Widen your terminal so the token fits on one line, then paste again.'
            : "Token shape doesn't look right (expected sk-ant-oat…AA).";
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).replace(/\s+/g, '');

  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'anthropic',
      '--value',
      token,
      '--host-pattern',
      'api.anthropic.com',
    ],
    {
      running: `Saving your ${label} to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    {
      extraFields: { METHOD: method },
    },
  );
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }
}

// ─── timezone step ─────────────────────────────────────────────────────

/**
 * Auto-detect TZ, confirm with the user when it comes back as UTC (a
 * common sign we're on a VPS that wasn't localised), and persist through
 * the usual `--step timezone -- --tz <zone>` path. Free-text answers get
 * a headless `claude -p` pass to resolve them to a real IANA zone.
 */
async function runTimezoneStep(): Promise<void> {
  const res = await runQuietStep('timezone', {
    running: 'Checking your timezone…',
    done: 'Timezone set.',
  });
  if (!res.ok && res.terminal?.fields.NEEDS_USER_INPUT !== 'true') {
    await fail('timezone', "Couldn't determine your timezone.");
  }

  const fields = res.terminal?.fields ?? {};
  const resolvedTz = fields.RESOLVED_TZ;
  const needsInput = fields.NEEDS_USER_INPUT === 'true';
  const isUtc = resolvedTz === 'UTC' || resolvedTz === 'Etc/UTC' || resolvedTz === 'Universal';

  if (!needsInput && !isUtc && resolvedTz && resolvedTz !== 'none') {
    return;
  }

  // Either autodetect failed outright, or it landed on UTC and we should
  // check that's really what the user wants before leaving it there.
  const message = needsInput
    ? "Your system didn't expose a timezone. Which one are you in?"
    : 'Your system reports UTC as the timezone. Is that right, or are you somewhere else?';

  const choice = ensureAnswer(
    await p.select({
      message,
      options: needsInput
        ? [
            { value: 'answer', label: "I'll tell you where I am" },
            { value: 'keep', label: 'Leave it as UTC' },
          ]
        : [
            { value: 'keep', label: 'Keep UTC', hint: 'remote server / happy with UTC' },
            { value: 'answer', label: "I'm somewhere else" },
          ],
    }),
  ) as 'keep' | 'answer';
  setupLog.userInput('timezone_choice', choice);

  if (choice === 'keep') return;

  const answer = ensureAnswer(
    await p.text({
      message: 'Where are you? (city, region, or IANA zone)',
      placeholder: 'e.g. New York, London, Asia/Tokyo',
      validate: (v) => (v && v.trim() ? undefined : 'Required'),
    }),
  );
  const raw = (answer as string).trim();
  setupLog.userInput('timezone_input', raw);

  let tz: string | null = isValidTimezone(raw) ? raw : null;
  if (!tz) {
    if (claudeCliAvailable()) {
      tz = await resolveTimezoneViaClaude(raw);
    } else {
      p.log.warn(
        wrapForGutter(
          "That's not a standard IANA zone and I can't call Claude to interpret it here — try again with a zone like `America/New_York` or `Europe/London`.",
          4,
        ),
      );
    }
  }

  if (!tz) {
    // One retry with a direct-IANA ask; if that fails too, leave the
    // previously-detected value in .env and move on rather than looping.
    const retryAnswer = ensureAnswer(
      await p.text({
        message: 'Enter an IANA timezone string',
        placeholder: 'e.g. America/New_York',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required';
          if (!isValidTimezone(s)) return 'Not a valid IANA zone';
          return undefined;
        },
      }),
    );
    tz = (retryAnswer as string).trim();
    setupLog.userInput('timezone_retry', tz);
  }

  const persist = await runQuietStep(
    'timezone',
    {
      running: `Saving timezone ${tz}…`,
      done: `Timezone set to ${tz}.`,
    },
    ['--tz', tz],
  );
  if (!persist.ok) {
    await fail('timezone', `Couldn't save timezone ${tz}.`);
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(): Promise<'telegram' | 'discord' | 'whatsapp' | 'teams' | 'skip'> {
  const choice = ensureAnswer(
    await p.select({
      message: 'Want to chat with your assistant from your phone?',
      options: [
        { value: 'telegram', label: 'Yes, connect Telegram', hint: 'recommended' },
        { value: 'discord', label: 'Yes, connect Discord' },
        { value: 'whatsapp', label: 'Yes, connect WhatsApp' },
        { value: 'teams', label: 'Yes, connect Microsoft Teams', hint: 'complex setup' },
        { value: 'other', label: 'Other…', hint: 'install via /add-<name> after setup' },
        { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  phEmit('channel_chosen', { channel: String(choice) });
  return choice as 'telegram' | 'discord' | 'whatsapp' | 'teams' | 'skip';
}

async function askOtherChannelName(): Promise<void | typeof BACK_TO_CHANNEL_SELECTION> {
  const action = ensureAnswer(
    await brightSelect<'type' | 'back'>({
      message: 'Which channel would you like to install?',
      options: [
        {
          value: 'type',
          label: 'Type the channel name',
          hint: 'e.g. matrix, github, linear, webex',
        },
        { value: 'back', label: '← Back to channel selection' },
      ],
      initialValue: 'type',
    }),
  );
  if (action === 'back') return BACK_TO_CHANNEL_SELECTION;

  const answer = ensureAnswer(
    await p.text({
      message: 'Channel name',
      placeholder: 'e.g. matrix, github, linear, webex',
    }),
  );
  const name = (answer as string).trim().toLowerCase().replace(/^\/?(add-)?/, '');
  setupLog.userInput('other_channel', name);
  phEmit('channel_other_named', { channel: name });
  p.log.info(
    brandBody(
      wrapForGutter(
        `No bash installer for ${k.bold(name)} — open Claude Code after setup and run ${k.bold(`/add-${name}`)} to install it.`,
        4,
      ),
    ),
  );
}

// ─── interactive / env helpers ─────────────────────────────────────────

function ensureLocalBinOnPath(): void {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const current = process.env.PATH ?? '';
  const segments = current.split(path.delimiter).filter(Boolean);
  if (segments.includes(localBin)) return;
  process.env.PATH = current ? `${localBin}${path.delimiter}${current}` : localBin;
}

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn(brandBody('Docker socket not accessible in current group. Re-executing under `sg docker`.'));
  const existingSkip = (process.env.NANOCLAW_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const skipList = [...new Set([...existingSkip, ...setupLog.completedStepNames()])].join(',');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1', ...(skipList ? { NANOCLAW_SKIP: skipList } : {}) },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(`${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`);
    return;
  }

  // Always include the wordmark inside the clack intro line. When bash ran
  // first (NANOCLAW_BOOTSTRAPPED=1) it already printed its own wordmark
  // above us; the small repeat is worth it to keep the brand anchored at
  // the visible top of the clack session once the bash output scrolls away.
  p.intro(`${wordmark}  ${k.dim("Let's get you set up.")}`);
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
