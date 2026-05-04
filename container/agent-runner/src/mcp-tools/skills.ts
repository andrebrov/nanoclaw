/**
 * Progressive skill loading MCP tools: list_skills + get_skill.
 *
 * Skills marked as `progressiveSkills` in container.json are not symlinked into
 * .claude/skills/ at startup — Claude Code does not load their SKILL.md eagerly.
 * These tools provide on-demand access:
 *   - list_skills: compact manifest (name + description) for all skills in /app/skills/
 *   - get_skill:   full SKILL.md content for a specific skill
 *
 * Agents should call list_skills to see what's available, then get_skill to load
 * the full instructions before using a skill they haven't seen before.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SKILLS_DIR = '/app/skills';

// Only allow safe skill names — alphanumeric, hyphens, underscores.
// No path separators or ".." to prevent directory traversal.
const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface SkillMeta {
  name: string;
  description: string;
}

/**
 * Extract name and description from a SKILL.md frontmatter block.
 * Handles quoted (single or double) and unquoted description values.
 */
function parseSkillMeta(content: string): SkillMeta | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  const descMatch = fm.match(/^description:\s*([\s\S]*?)(?=\n\S|\n*$)/m);
  const description = descMatch
    ? descMatch[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim()
    : '';

  return { name, description };
}

function listAvailableSkills(): SkillMeta[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills: SkillMeta[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const skillMdPath = path.join(SKILLS_DIR, entry, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const meta = parseSkillMeta(content);
      if (meta) skills.push(meta);
    } catch {
      /* skip unreadable */
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export const listSkills: McpToolDefinition = {
  tool: {
    name: 'list_skills',
    description:
      'List all available skills with their names and one-line descriptions. Use this to discover what skills can be loaded on demand, then call get_skill to load the full instructions before using a skill.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const skills = listAvailableSkills();
    if (skills.length === 0) {
      return ok('No skills available.');
    }
    const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);
    return ok(`Available skills:\n\n${lines.join('\n')}`);
  },
};

export const getSkill: McpToolDefinition = {
  tool: {
    name: 'get_skill',
    description:
      'Load the full instructions for a specific skill by name. Call this before using a skill to get complete usage details. Use list_skills first to see what skills are available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'The skill name (e.g. "agent-browser"). Use list_skills to see available names.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');
    if (!SAFE_SKILL_NAME_RE.test(name)) {
      return err(`Invalid skill name "${name}". Use only letters, digits, hyphens, and underscores.`);
    }

    const skillMdPath = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      const available = listAvailableSkills()
        .map((s) => s.name)
        .join(', ');
      return err(`Skill "${name}" not found. Available: ${available || 'none'}`);
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      return ok(content);
    } catch (e) {
      return err(`Failed to read skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerTools([listSkills, getSkill]);
