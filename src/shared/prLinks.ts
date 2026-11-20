// The text "Copy" puts on the clipboard for "Your PRs waiting": a header line, then one PR per line as
// "- repo#123 Title https://github.com/…". Built by the main process from its own copy of the numbers, so
// the window can't put arbitrary text on the clipboard. Pure, so scripts/check.ts can test it.
import type { PrSummary } from './types';
import { allowedGitHubLink } from './validate';

export const COPY_HEADER = 'Need reviewers on these, please:';
/** More than anyone would paste into a chat; keeps the text a sensible size. */
export const MAX_COPIED_PRS = 100;
const MAX_TITLE_LENGTH = 120;

/**
 * GitHub-supplied text on one line: control and format characters (including right-to-left overrides,
 * which could make a title appear to say something else) and line breaks become spaces.
 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Empty when there's nothing to copy. Only pull-request links on github.com make it in. */
export function prLinksText(prs: PrSummary[]): string {
  const lines = prs.slice(0, MAX_COPIED_PRS).flatMap((pr) => {
    const url = allowedGitHubLink(pr.url);
    if (!url || !/\/pull\/\d+\/?$/.test(new URL(url).pathname) || !Number.isInteger(pr.number)) return [];
    const repo = oneLine(pr.repo.split('/').pop() ?? '', 100);
    return [`- ${repo}#${pr.number} ${oneLine(pr.title, MAX_TITLE_LENGTH)} ${url}`];
  });
  return lines.length > 0 ? [COPY_HEADER, ...lines].join('\n') : '';
}
