import { Lexer } from 'marked';

/** Bold prose line by line, leaving code blocks and table syntax intact. */
export function boldFinalAnswer(content: string): string {
  let fence: { char: string; length: number } | undefined;
  return content.split('\n').map(line => {
    const marker = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return line;
    }
    if (fence || !line.trim() || /^(?: {4}|\t)/.test(line) || /^\s*\|/.test(line) ||
      /^\s*(?:(?:[-*_]\s*){3,}|[-=:]{3,})\s*$/.test(line)) return line;
    const parts = line.match(/^(\s*(?:(?:>\s*)+)?(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?)(.*?)(\s*)$/)!;
    const body = parts[2]!;
    if (!body) return line;
    // Remove only parsed emphasis markers; preserve literal ** in inline code.
    const plainStrong = (text: string): string => Lexer.lexInline(text).map(token =>
      token.type === 'strong' ? plainStrong(token.raw.slice(2, -2)) : token.raw).join('');
    return parts[1] + '**' + plainStrong(body) + '**' + parts[3];
  }).join('\n');
}
