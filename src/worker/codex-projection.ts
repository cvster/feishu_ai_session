import type { CodexThreadTurn } from '../session/codex-thread-reader';
export function externalUserText(turn: CodexThreadTurn): string {
  const user = turn.items.find((item) => item.type === 'userMessage');
  return user ? textFromUnknown(user.content).trim() : '';
}


function textFromUnknown(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.map(value => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    return typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
  }).filter(Boolean).join('\n');
}
