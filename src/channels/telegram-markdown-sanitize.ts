/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

// Telegram Bot API 7.x HTML tags. Phase 1b passes these through; anything else
// is entity-escaped so stray tokens like <tool_use_error> render as visible
// text instead of triggering a silent 400 from the Bot API.
const TELEGRAM_ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'tg-emoji',
  'a',
  'code',
  'pre',
  'blockquote',
]);

/**
 * Prepare agent output for Telegram HTML parse mode.
 *
 * - Converts the most common CommonMark Markdown patterns (bold, code) to
 *   their HTML equivalents so they render correctly in HTML parse mode.
 * - Preserves existing Telegram-allowed HTML tags (already HTML-ready).
 * - Code spans and blocks are wrapped in <code>/<pre>; their content is
 *   kept verbatim — callers send with parse_mode:'HTML' and a 400 fallback
 *   strips all tags, so imperfect escaping inside code blocks is tolerable.
 * - Italic (`*...*`, `_..._`) is intentionally NOT converted: single-asterisk
 *   and underscore patterns have too many false positives in prose and
 *   snake_case identifiers. Agents can use <i>...</i> directly.
 */
export function toTelegramHtml(input: string): string {
  if (!input) return input;

  const codeParts: string[] = [];
  let text = input.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    codeParts.push(m);
    return `\x00CODE${codeParts.length - 1}\x00`;
  });

  // CommonMark bold → HTML bold
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]+?)__/g, '<b>$1</b>');

  return text.replace(/\x00CODE(\d+)\x00/g, (_, i: string) => {
    const block = codeParts[Number(i)]!;
    if (block.startsWith('```')) {
      const inner = block.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      return `<pre>${inner}</pre>`;
    }
    return `<code>${block.slice(1, -1)}</code>`;
  });
}

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Convert Telegram HTML formatting tags to legacy Markdown equivalents.
  // The adapter processes text as CommonMark, which treats <b>/<i> as inline
  // HTML and HTML-escapes them to &lt;b&gt; before sending to the Bot API.
  // Converting known formatting tags here ensures the adapter sees Markdown
  // syntax instead of HTML, so <b>hello</b> renders as bold text rather than
  // literal &lt;b&gt;hello&lt;/b&gt;.
  text = text.replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*');
  text = text.replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*');
  text = text.replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_');
  text = text.replace(/<em>([\s\S]*?)<\/em>/gi, '_$1_');

  // Phase 1b: escape any remaining HTML-shaped tokens not in the Telegram Bot
  // API allowlist. Tag names are underscore-widened so <tool_use_error>-style
  // tokens are matched. Known tags pass through; unknown ones become
  // &lt;tag&gt; and render as visible text rather than causing a silent 400.
  text = text.replace(/<\/?([A-Za-z][A-Za-z0-9_-]*)[^>]*>/g, (match, tagName: string) =>
    TELEGRAM_ALLOWED_TAGS.has(tagName.toLowerCase()) ? match : match.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  // Flatten Markdown horizontal rules (bare --- / *** / ___ lines) to a
  // plain Unicode divider. The parser doesn't understand HR syntax and the
  // `*` / `_` characters would otherwise unbalance the delimiter counts below.
  text = text.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '⎯⎯⎯');

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  const starCount = (text.match(/\*/g) ?? []).length;
  const underCount = (text.match(/_/g) ?? []).length;
  if (starCount % 2 !== 0 || underCount % 2 !== 0) {
    text = text.replace(/[*_]/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
