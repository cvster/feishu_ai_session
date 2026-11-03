import { PROMPT_CONTEXT_TAGS } from '../agent/prompt';

const DEFAULT_PREVIEW_MAX_CHARS = 80;

/** Only bridge-shaped prompts start with a context tag; user prose never does. */
const CONTEXT_OPEN = new RegExp(`^\\s*<(${PROMPT_CONTEXT_TAGS.join('|')})>`);

export function normalizeSessionPreview(input: string, maxChars = DEFAULT_PREVIEW_MAX_CHARS): string {
  const text = extractBridgeUserInput(input) ?? stripContextSections(input);
  return truncatePreview(text.replace(/\s+/g, ' ').trim(), maxChars);
}

/** Direct prompts append the user's words after the context block; drop everything before it. */
function stripContextSections(input: string): string {
  let rest = input;
  for (;;) {
    const open = rest.match(CONTEXT_OPEN);
    const tag = open?.[1];
    if (!tag) return rest;
    const end = rest.indexOf(`</${tag}>`, open[0].length);
    // An unterminated section means nothing but context was recorded.
    if (end < 0) return '';
    rest = rest.slice(end + tag.length + 3);
  }
}

function extractBridgeUserInput(input: string): string | undefined {
  const section = readPromptSection(input, 'user_input');
  if (!section) return undefined;
  const parsed = parseJsonObject(section);
  const text = typeof parsed?.text === 'string' ? parsed.text : undefined;
  return text?.trim() ? text : undefined;
}

function readPromptSection(input: string, tag: string): string | undefined {
  const match = input.match(new RegExp(`<${tag}>\\r?\\n([\\s\\S]*?)\\r?\\n</${tag}>`));
  return match?.[1];
}

function parseJsonObject(input: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function truncatePreview(input: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const chars = Array.from(input);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : input;
}
