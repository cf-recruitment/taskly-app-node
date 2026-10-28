// Untrusted text → markdown that is safe to post. Agent summaries can be steered by the PR body,
// and file paths come from the PR, so neither may add HTML, pings, external links or images.

const MAX_SUMMARY = 3000;
const MAX_CELL = 300;
const ZWSP = '\u200b'; // zero-width space: breaks @mentions and #refs without visible change

export function sanitize(text: string, repo: string, max = MAX_SUMMARY): string {
  const own = `https://github.com/${repo}/`;
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, '')
    .replace(/&#?\w+;/g, '')
    .replace(/</g, '&lt;')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (_all, label, url) => (url.startsWith(own) ? `[${label}](${url})` : label))
    .replace(/https?:\/\/[^\s)>\]]+/g, (url) => (url.startsWith(own) ? url : '[link removed]'))
    .replace(/(^|[^\w`/])@(?=\w)/g, `$1@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`);
  return cleaned.length > max ? cleaned.slice(0, max) + '\n\n(truncated)' : cleaned;
}

// One line of text that can sit in a table cell or list item.
export const cell = (text: string, repo: string) =>
  sanitize(text, repo, MAX_CELL).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// Inline code; a backtick in the text would end the code span early.
export const code = (text: string, repo: string) => `\`${cell(text, repo).replace(/`/g, "'")}\``;
