/**
 * send_voice MCP tool — ElevenLabs TTS + gender-inversion via ffmpeg.
 *
 * Pipeline:
 *   1. POST /v1/text-to-speech/{voice_id} → MP3 bytes
 *   2. ffmpeg pitch+formant shift (asetrate=44100*1.3,aresample=44100,atempo=0.77)
 *   3. OGG/Opus encode → /workspace/outbox/<id>/voice.ogg
 *   4. outbound message with kind='voice' so the Telegram adapter calls sendVoice
 *
 * Silent no-op when ElevenLabs is not configured:
 *   - ELEVENLABS_API_KEY absent AND the API returns 401/403 → returns a clear
 *     "not configured" error to the agent instead of crashing.
 *
 * The gender-inversion filter shifts pitch ~4-5 semitones up (female range),
 * making the output voice clearly distinguishable from the source voice.
 * This provides misattribution protection in group chats.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getSessionRouting } from '../db/session-routing.js';
import { writeMessageOut } from '../db/messages-out.js';
import { setTurnSendInvoked } from '../db/session-state.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const FFMPEG_FILTER = 'asetrate=44100*1.3,aresample=44100,atempo=0.77';

function log(msg: string): void {
  console.error(`[send-voice] ${msg}`);
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

function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to!);
  if (!dest) {
    const all = getAllDestinations();
    return {
      error: `Unknown destination "${to}". Known: ${all.length === 0 ? '(none)' : all.map((d) => d.name).join(', ')}`,
    };
  }
  if (dest.type === 'channel') {
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to!,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to! };
}

/** Call ElevenLabs TTS API, return raw MP3 bytes. */
async function ttsToMp3(text: string, voiceId: string, apiKey: string | null): Promise<Buffer | { status: number }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/mpeg' };
  if (apiKey) headers['xi-api-key'] = apiKey;

  const res = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      output_format: 'mp3_44100_128',
    }),
  });

  if (!res.ok) {
    return { status: res.status };
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** Apply pitch+formant shift via ffmpeg, encode to OGG/Opus. Returns OGG bytes. */
async function applyGenderInversion(mp3Bytes: Buffer): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-voice-'));
  const inPath = path.join(tmpDir, 'in.mp3');
  const outPath = path.join(tmpDir, 'out.ogg');

  try {
    fs.writeFileSync(inPath, mp3Bytes);

    const proc = Bun.spawn(
      [
        'ffmpeg',
        '-y',
        '-i', inPath,
        '-af', FFMPEG_FILTER,
        '-c:a', 'libopus',
        '-b:a', '64k',
        outPath,
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`ffmpeg exited ${exitCode}: ${stderr.slice(-300)}`);
    }

    return Buffer.from(fs.readFileSync(outPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export const sendVoice: McpToolDefinition = {
  tool: {
    name: 'send_voice',
    description:
      'Send a voice note synthesized from text using ElevenLabs IVC. ' +
      'The output pitch is shifted ~4-5 semitones up (gender-inverted) for misattribution protection. ' +
      'Requires ffmpeg in the container and ELEVENLABS_API_KEY / OneCLI vault entry. ' +
      'Returns an error (does not crash) when ElevenLabs is not configured. ' +
      'Use this when voice output adds value (announcements, personal messages); prefer text for normal replies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Text to synthesize into speech.',
        },
        to: {
          type: 'string',
          description: 'Destination name. Optional if you have only one destination.',
        },
        voice_id: {
          type: 'string',
          description:
            'ElevenLabs voice ID to use. Defaults to ELEVENLABS_VOICE_ID env var if omitted. ' +
            'Create an IVC voice at elevenlabs.io and paste the voice ID here.',
        },
      },
      required: ['text'],
    },
  },

  async handler(args) {
    const text = args.text as string;
    if (!text || !text.trim()) return err('text is required');

    const voiceId = (args.voice_id as string | undefined) || process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) {
      return err(
        'No ElevenLabs voice ID configured. ' +
          'Set ELEVENLABS_VOICE_ID in your .env or pass voice_id explicitly. ' +
          'Create an IVC voice at elevenlabs.io first.',
      );
    }

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const apiKey = process.env.ELEVENLABS_API_KEY ?? null;

    log(`Requesting TTS for ${text.length} chars via voice ${voiceId}`);
    let mp3Result: Buffer | { status: number };
    try {
      mp3Result = await ttsToMp3(text, voiceId, apiKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`ElevenLabs request failed: ${msg}`);
    }

    if (!Buffer.isBuffer(mp3Result)) {
      const status = mp3Result.status;
      if (status === 401 || status === 403) {
        return err(
          `ElevenLabs not configured (HTTP ${status}). ` +
            'Add ELEVENLABS_API_KEY to your .env or vault, then restart the container.',
        );
      }
      return err(`ElevenLabs API returned HTTP ${status}`);
    }

    log('Applying gender-inversion filter via ffmpeg');
    let oggBytes: Buffer;
    try {
      oggBytes = await applyGenderInversion(mp3Result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`ffmpeg processing failed: ${msg}. Is ffmpeg installed? (install_packages apt: ffmpeg)`);
    }

    const id = generateId();
    const filename = 'voice.ogg';
    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, filename), oggBytes);

    const seq = writeMessageOut({
      id,
      kind: 'voice',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ files: [filename] }),
    });

    setTurnSendInvoked();
    log(`send_voice: #${seq} → ${routing.resolvedName} (${oggBytes.length} bytes OGG)`);
    return ok(`Voice note sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

registerTools([sendVoice]);
