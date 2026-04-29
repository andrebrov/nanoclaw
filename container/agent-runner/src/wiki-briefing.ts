/**
 * Session-start wiki briefing.
 *
 * At container startup, reads /workspace/global/knowledge/wiki/INDEX.md,
 * scores each article for relevance to the current agent, then reads and
 * injects the top articles as a <knowledge-base> block in the system context.
 *
 * Relevance scoring (additive):
 *   +2  always-include tags (core, finsi, process)
 *   +1  per tag that matches the agent's "My tags" from CLAUDE.local.md
 *   +1  per tag that matches a keyword in the agent/group name
 *   +1  article updated within the last 7 days (updated: YYYY-MM-DD frontmatter)
 *
 * INDEX.md format — one entry per article, either table or section form:
 *
 *   Table form:
 *     | [Title](path/to/article.md) | Summary text | tag1, tag2 |
 *
 *   Section form:
 *     ## Article Title
 *     File: path/to/article.md
 *     Tags: tag1, tag2
 *     Updated: 2024-03-15
 *     Summary: One-line summary.
 *
 * Gracefully no-ops if the wiki or index doesn't exist.
 */
import fs from 'fs';
import path from 'path';

const WIKI_INDEX_PATH = '/workspace/global/knowledge/wiki/INDEX.md';
const CLAUDE_LOCAL_PATH = '/workspace/agent/CLAUDE.local.md';
const MAX_ARTICLES = 5;
const ALWAYS_INCLUDE_TAGS = new Set(['core', 'finsi', 'process']);
const RECENCY_DAYS = 7;
const MIN_SCORE_TO_INCLUDE = 1;

export interface WikiArticle {
  title: string;
  filePath: string;
  summary: string;
  tags: string[];
  updatedAt?: Date;
}

function log(msg: string): void {
  console.error(`[wiki-briefing] ${msg}`);
}

/**
 * Parse the INDEX.md content into a list of articles.
 * Supports both table rows and section-based entries.
 */
export function parseIndex(content: string): WikiArticle[] {
  const articles: WikiArticle[] = [];

  // Try table form first: rows like | [Title](path) | Summary | tag1, tag2 |
  const tableRowRe = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/gm;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRowRe.exec(content)) !== null) {
    const [, title, filePath, summary, tagStr] = tableMatch;
    // Skip header separator rows
    if (/^[-:\s|]+$/.test(summary) && /^[-:\s|]+$/.test(tagStr)) continue;
    const tags = tagStr
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    articles.push({ title: title.trim(), filePath: filePath.trim(), summary: summary.trim(), tags });
  }

  if (articles.length > 0) return articles;

  // Section form: ## Title\nFile: ...\nTags: ...\nUpdated: ...\nSummary: ...
  const sections = content.split(/\n(?=##\s)/);
  for (const section of sections) {
    const titleMatch = section.match(/^##\s+(.+)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();

    const fileMatch = section.match(/^File:\s*(.+)/im);
    const tagsMatch = section.match(/^Tags:\s*(.+)/im);
    const updatedMatch = section.match(/^Updated:\s*(\d{4}-\d{2}-\d{2})/im);
    const summaryMatch = section.match(/^Summary:\s*(.+)/im);

    if (!fileMatch) continue;

    const tags = tagsMatch
      ? tagsMatch[1]
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : [];

    const updatedAt = updatedMatch ? new Date(updatedMatch[1]) : undefined;

    articles.push({
      title,
      filePath: fileMatch[1].trim(),
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      tags,
      updatedAt,
    });
  }

  return articles;
}

/**
 * Extract the agent's wiki tags from its CLAUDE.local.md.
 * Looks for a "My tags:" line in any ## Knowledge Wiki section,
 * or anywhere in the file.
 */
export function extractAgentTags(claudeLocalContent: string): string[] {
  // Match "My tags: [tag1, tag2, tag3]" or "My tags: tag1, tag2"
  const tagsMatch = claudeLocalContent.match(/My tags:\s*\[?([^\]\n]+)\]?/i);
  if (!tagsMatch) return [];
  return tagsMatch[1]
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Score an article's relevance given the agent context.
 */
export function scoreArticle(article: WikiArticle, agentTags: string[], nameKeywords: string[], now: Date): number {
  let score = 0;

  for (const tag of article.tags) {
    if (ALWAYS_INCLUDE_TAGS.has(tag)) {
      score += 2;
      break;
    }
  }

  for (const tag of article.tags) {
    if (agentTags.includes(tag)) score += 1;
    if (nameKeywords.some((kw) => tag.includes(kw) || kw.includes(tag))) score += 1;
  }

  if (article.updatedAt) {
    const ageMs = now.getTime() - article.updatedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= RECENCY_DAYS) score += 1;
  }

  return score;
}

/**
 * Derive keyword tokens from assistant/group name for tag matching.
 */
function nameToKeywords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((w) => w.length > 2);
}

/**
 * Build the wiki briefing addendum to inject into the system context.
 * Returns an empty string if the wiki doesn't exist or has no relevant articles.
 */
export function buildWikiBriefing(assistantName: string, groupName: string): string {
  // Graceful no-op: wiki doesn't exist yet
  if (!fs.existsSync(WIKI_INDEX_PATH)) return '';

  let indexContent: string;
  try {
    indexContent = fs.readFileSync(WIKI_INDEX_PATH, 'utf-8');
  } catch (err) {
    log(`Failed to read index: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }

  const articles = parseIndex(indexContent);
  if (articles.length === 0) {
    log('Index parsed but no articles found');
    return '';
  }

  // Read agent tags from CLAUDE.local.md (graceful if absent)
  let agentTags: string[] = [];
  if (fs.existsSync(CLAUDE_LOCAL_PATH)) {
    try {
      const localContent = fs.readFileSync(CLAUDE_LOCAL_PATH, 'utf-8');
      agentTags = extractAgentTags(localContent);
    } catch {
      // non-fatal
    }
  }

  const nameKeywords = [...nameToKeywords(assistantName || ''), ...nameToKeywords(groupName || '')];

  const now = new Date();
  const scored = articles
    .map((a) => ({ article: a, score: scoreArticle(a, agentTags, nameKeywords, now) }))
    .filter(({ score }) => score >= MIN_SCORE_TO_INCLUDE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ARTICLES);

  if (scored.length === 0) {
    log('No articles met relevance threshold');
    return '';
  }

  // Read article files
  const wikiDir = path.dirname(WIKI_INDEX_PATH);
  const sections: string[] = [];

  for (const { article, score } of scored) {
    const articlePath = path.isAbsolute(article.filePath) ? article.filePath : path.join(wikiDir, article.filePath);

    let body = '';
    if (fs.existsSync(articlePath)) {
      try {
        body = fs.readFileSync(articlePath, 'utf-8').trim();
      } catch (err) {
        log(`Failed to read article ${article.filePath}: ${err instanceof Error ? err.message : String(err)}`);
        body = article.summary;
      }
    } else {
      // Article file missing — fall back to summary only
      body = article.summary;
    }

    sections.push(`### ${article.title}\n\n${body}`);
    log(`Including article "${article.title}" (score=${score})`);
  }

  if (sections.length === 0) return '';

  return (
    `\n\n<knowledge-base>\n` +
    `The following articles from the shared knowledge wiki are relevant to your role. ` +
    `Use this knowledge as background context for the session.\n\n` +
    sections.join('\n\n---\n\n') +
    `\n</knowledge-base>`
  );
}
