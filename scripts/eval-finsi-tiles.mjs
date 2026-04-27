#!/usr/bin/env node
/**
 * Evaluate every finsi/* tile against the publishing-readiness rubric.
 *
 * Per-tile checks:
 *   tile.json   parse, required fields, name shape, version shape,
 *               summary present + non-empty + reasonable length,
 *               every skills.<name>.path resolves to a real file.
 *   SKILL.md    YAML frontmatter present, has `name` + `description`,
 *               name matches directory name (Claude-skill discovery rule),
 *               description ends with a period or sentence-ish text and is
 *               long enough to be useful for trigger matching.
 *   body        SKILL.md has ≥3 non-empty content lines after the
 *               frontmatter; absurdly short bodies probably aren't real
 *               skills.
 *
 * Exit codes:
 *   0 — all tiles PASS
 *   1 — at least one tile has WARN findings, no FAILs
 *   2 — at least one tile FAILED
 */
import fs from 'fs';
import path from 'path';

const ROOT = '/home/andrei/nanoclaw';
const ROOTS = [
  path.join(ROOT, 'container/skills'),
  path.join(ROOT, 'groups/main/skills'),
];

const SUMMARY_MIN = 30;
const SUMMARY_MAX = 800;
const DESC_MIN = 30;
const BODY_MIN_LINES = 3;

function readFrontmatter(txt) {
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: txt };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

const findings = [];
let pass = 0;

for (const base of ROOTS) {
  if (!fs.existsSync(base)) continue;
  for (const e of fs.readdirSync(base)) {
    const dir = path.join(base, e);
    if (!fs.statSync(dir).isDirectory()) continue;
    const tilePath = path.join(dir, 'tile.json');
    const skillPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(tilePath) || !fs.existsSync(skillPath)) continue;

    const errs = [];
    const warns = [];

    let tile;
    try {
      tile = JSON.parse(fs.readFileSync(tilePath, 'utf8'));
    } catch (err) {
      errs.push(`tile.json invalid JSON: ${err.message}`);
    }

    if (tile) {
      if (tile.name !== `finsi/${e}`) {
        errs.push(`tile.name "${tile.name}" should be "finsi/${e}"`);
      }
      if (!/^\d+\.\d+\.\d+/.test(String(tile.version || ''))) {
        errs.push(`tile.version "${tile.version}" not semver`);
      }
      if (typeof tile.summary !== 'string' || tile.summary.length < SUMMARY_MIN) {
        errs.push(`tile.summary too short (${tile.summary?.length || 0} < ${SUMMARY_MIN})`);
      }
      if (typeof tile.summary === 'string' && tile.summary.length > SUMMARY_MAX) {
        warns.push(`tile.summary very long (${tile.summary.length} > ${SUMMARY_MAX}) — may be verbose for trigger`);
      }
      if (typeof tile.private !== 'boolean') {
        warns.push(`tile.private should be boolean (is ${typeof tile.private})`);
      }
      if (!tile.skills || typeof tile.skills !== 'object') {
        errs.push('tile.skills missing or not object');
      } else {
        for (const [sk, sv] of Object.entries(tile.skills)) {
          const p = path.join(dir, sv.path || '');
          if (!fs.existsSync(p)) errs.push(`tile.skills.${sk}.path → ${sv.path} not found`);
        }
        if (!(e in tile.skills)) {
          warns.push(`tile.skills missing entry "${e}" (dir name)`);
        }
      }
    }

    const skillTxt = fs.readFileSync(skillPath, 'utf8');
    const { fm, body } = readFrontmatter(skillTxt);
    if (!fm) {
      errs.push('SKILL.md missing YAML frontmatter');
    } else {
      if (fm.name !== e) {
        errs.push(`SKILL.md name "${fm.name}" should match dir "${e}"`);
      }
      if (typeof fm.description !== 'string' || fm.description.length < DESC_MIN) {
        errs.push(`SKILL.md description missing or short (${fm.description?.length || 0} < ${DESC_MIN})`);
      }
    }
    const bodyLines = (body || '').split('\n').filter((l) => l.trim().length > 0).length;
    if (bodyLines < BODY_MIN_LINES) {
      errs.push(`SKILL.md body too short (${bodyLines} < ${BODY_MIN_LINES} non-empty lines)`);
    }

    if (errs.length) findings.push({ dir: path.relative(ROOT, dir), level: 'FAIL', errs, warns });
    else if (warns.length) findings.push({ dir: path.relative(ROOT, dir), level: 'WARN', errs: [], warns });
    else pass++;
  }
}

const fails = findings.filter((f) => f.level === 'FAIL');
const warnsOnly = findings.filter((f) => f.level === 'WARN');

console.log(`PASS: ${pass}`);
console.log(`WARN: ${warnsOnly.length}`);
console.log(`FAIL: ${fails.length}`);
console.log('---');
for (const f of fails) {
  console.log(`FAIL ${f.dir}`);
  for (const e of f.errs) console.log(`  ! ${e}`);
  for (const w of f.warns) console.log(`  ~ ${w}`);
}
for (const f of warnsOnly) {
  console.log(`WARN ${f.dir}`);
  for (const w of f.warns) console.log(`  ~ ${w}`);
}

process.exit(fails.length > 0 ? 2 : warnsOnly.length > 0 ? 1 : 0);
