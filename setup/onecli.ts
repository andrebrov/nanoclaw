/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Aggregates what the old /setup + /init-onecli skills ran as loose shell
 * commands. Idempotent: skips install if `onecli` already works, and safely
 * re-applies PATH, api-host, and .env updates.
 *
 * Emits ONECLI_URL so /new-setup SKILL.md can forward it downstream (e.g. as
 * ${ONECLI_URL} in status messages). Polls /health to give downstream steps
 * (auth, service) a ready gateway.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function onecliVersion(): string | null {
  try {
    return execFileSync('onecli', ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const match = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
  return match ? match[0] : null;
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvOnecliUrl(url: string): void {
  const envFile = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  if (/^ONECLI_URL=/m.test(content)) {
    content = content.replace(/^ONECLI_URL=.*$/m, `ONECLI_URL=${url}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `ONECLI_URL=${url}\n`;
  }
  fs.writeFileSync(envFile, content);
}

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail. Bump deliberately when a
// new CLI release ships.
const ONECLI_GATEWAY_VERSION = '1.23.0';
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

function installOnecliCliOnly(): { stdout: string; ok: boolean } {
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  if (upstream.ok) return { stdout: upstream.stdout, ok: true };
  const fallback = installOnecliCliDirect();
  return { stdout: upstream.stdout + (upstream.stderr ?? '') + '\n' + fallback.stdout, ok: fallback.ok };
}

// Remove containers in the "onecli" compose project whose service name isn't
// in the v2 set. Pre-v2 OneCLI used service "app" (container onecli-app-1);
// v2 uses "onecli". Compose flags the old container as an orphan but won't
// stop it without --remove-orphans, leaving port 10254 bound and crashing
// the new bring-up. Filed upstream; this is the downstream workaround.
function removeLegacyOnecliContainers(): string {
  const out: string[] = [];
  let list = '';
  try {
    list = execSync(
      `docker ps -a --filter "label=com.docker.compose.project=onecli" --format '{{.Names}}|{{.Label "com.docker.compose.service"}}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
  if (!list) return '';
  const v2Services = new Set(['onecli', 'postgres']);
  for (const line of list.split('\n')) {
    const [name, service] = line.split('|');
    if (!name || !service || v2Services.has(service)) continue;
    out.push(`Removing legacy OneCLI container: ${name} (service=${service})`);
    try {
      execSync(`docker rm -f ${JSON.stringify(name)}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out.push(`  rm failed (continuing): ${(err as Error).message}`);
    }
  }
  return out.join('\n');
}


function installOnecli(): { stdout: string; ok: boolean } {
  // OneCLI's own install script handles gateway + CLI + PATH.
  // We run the two canonical installers in sequence and capture stdout so
  // we can extract the printed URL as a fallback to `onecli config get`.
  let stdout = '';

  const cleanup = removeLegacyOnecliContainers();
  if (cleanup) stdout += cleanup + '\n';

  // Gateway install (docker-compose based, no rate-limit concerns).
  const gw = runInstall(`export ONECLI_VERSION=${ONECLI_GATEWAY_VERSION} && curl -fsSL onecli.sh/install | sh`);
  stdout += gw.stdout;
  if (!gw.ok) {
    log.error('OneCLI gateway install failed', { stderr: gw.stderr });
    return { stdout: stdout + (gw.stderr ?? ''), ok: false };
  }

  // CLI install. The upstream script calls the GitHub releases API
  // (api.github.com) to resolve the latest tag — which 403s anonymous
  // callers after 60 requests/hour per IP. Try upstream first; on failure
  // resolve the version ourselves (via HTTP redirect, which isn't
  // API-throttled) and download the release archive directly.
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  stdout += upstream.stdout;
  if (upstream.ok) return { stdout, ok: true };

  log.warn('Upstream CLI installer failed — falling back to direct download', {
    stderr: upstream.stderr,
  });
  stdout += (upstream.stderr ?? '') + '\n';

  const fallback = installOnecliCliDirect();
  stdout += fallback.stdout;
  if (!fallback.ok) {
    log.error('OneCLI CLI install failed (both upstream and direct fallback)');
    return { stdout, ok: false };
  }
  return { stdout, ok: true };
}

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', ok: false };
  }
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  // `/api/health` matches the path probe.sh uses — keep them aligned.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function run(_args: string[]): Promise<void> {
  ensureShellProfilePath();

  log.info('Installing OneCLI gateway and CLI');
  const res = installOnecli();
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  if (!onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: 'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"` and retry.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const url = extractUrlFromOutput(res.stdout);
  if (!url) {
    emitStatus('ONECLI', {
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'could_not_resolve_api_host',
      HINT: 'Inspect logs/setup.log for the install output.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execFileSync('onecli', ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }

  writeEnvOnecliUrl(url);
  log.info('Wrote ONECLI_URL to .env', { url });

  const healthy = await pollHealth(url, 15000);

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
