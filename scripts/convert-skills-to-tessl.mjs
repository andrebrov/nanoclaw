#!/usr/bin/env node
/**
 * Convert local Claude skills into Tessl tile format by writing a tile.json
 * sidecar in each skill folder. Idempotent — skips folders that already have
 * a tile.json. Uses the SKILL.md YAML frontmatter `description` for the tile
 * summary, falling back to the H1 / first paragraph.
 *
 * Scope:
 *   - container/skills/<name>/     → finsi/<name>@0.1.0 (private)
 *   - groups/main/skills/<name>/   → finsi/<name>@0.1.0 (private)
 *
 * Skipped intentionally:
 *   - .claude/skills/<name>/       (upstream NanoClaw infra; different workspace)
 *   - ~/.claude/skills/merchant-advocate (already a tile)
 */
import fs from 'fs';
import path from 'path';

const ROOT = '/home/andrei/nanoclaw';
const TARGETS = [
  path.join(ROOT, 'container/skills'),
  path.join(ROOT, 'groups/main/skills'),
];

function readFrontmatter(skillMd) {
  const txt = fs.readFileSync(skillMd, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  // Crude YAML — handles `key: value` and `key: "quoted"` only. SKILL.md files in
  // this repo all conform; bail loudly if anything else.
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

function summaryFor(skillName, skillMd) {
  const fm = readFrontmatter(skillMd);
  if (fm.description) return fm.description;
  // Fallback: first non-empty line after the frontmatter that isn't a heading.
  const txt = fs.readFileSync(skillMd, 'utf8').replace(/^---[\s\S]*?---\n/, '');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    return t.slice(0, 200);
  }
  return `${skillName} skill`;
}

let written = 0;
let skipped = 0;
let missing = 0;

for (const base of TARGETS) {
  if (!fs.existsSync(base)) {
    console.log(`SKIP base ${base} — not present`);
    continue;
  }
  for (const entry of fs.readdirSync(base)) {
    const dir = path.join(base, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const skillMd = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      missing++;
      continue;
    }
    const tilePath = path.join(dir, 'tile.json');
    if (fs.existsSync(tilePath)) {
      skipped++;
      continue;
    }
    const tile = {
      name: `finsi/${entry}`,
      version: '0.1.0',
      private: true,
      summary: summaryFor(entry, skillMd),
      skills: {
        [entry]: { path: 'SKILL.md' },
      },
    };
    fs.writeFileSync(tilePath, JSON.stringify(tile, null, 2) + '\n');
    written++;
    console.log(`+ ${path.relative(ROOT, tilePath)}`);
  }
}

console.log(`\nDONE — wrote ${written}, skipped ${skipped}, no SKILL.md ${missing}`);
