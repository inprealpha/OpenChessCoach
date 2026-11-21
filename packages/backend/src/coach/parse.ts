// Shared structured-reply parsing and normalization for Coach backends (Claude, Codex, Pi).
import type { Brush, CoachRawReply } from '@chess-coach/shared/coach/types';

const BRUSHES = new Set<Brush>(['green', 'blue', 'red', 'yellow']);

function emptyReply(text: string): CoachRawReply {
  return { text, moves: [], arrows: [], highlights: [], note: null };
}

/** Coerces a provider's structured JSON object into a `CoachRawReply`, falling back to streamed text. */
export function toRawReply(value: unknown, fallbackText: string): CoachRawReply {
  if (!value || typeof value !== 'object') return emptyReply(fallbackText);
  const o = value as Record<string, unknown>;
  const text = typeof o.text === 'string' && o.text.trim() ? o.text : fallbackText;
  const moves = Array.isArray(o.moves) ? o.moves.filter((m): m is string => typeof m === 'string') : [];
  const arrows = Array.isArray(o.arrows)
    ? o.arrows
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => typeof a.uci === 'string' && typeof a.brush === 'string' && BRUSHES.has(a.brush as Brush))
        .map((a) => ({ uci: a.uci as string, brush: a.brush as Brush }))
    : [];
  const highlights = Array.isArray(o.highlights) ? o.highlights.filter((h): h is string => typeof h === 'string') : [];
  const note = typeof o.note === 'string' && o.note.trim() ? o.note : null;
  return { text, moves, arrows, highlights, note };
}

/**
 * Parses a reply that may be either pure JSON matching `REPLY_SCHEMA` or plain-language explanation
 * followed by a trailing fenced JSON block (` ```json ... ``` `).
 */
export function parseTextAndStructuredReply(raw: string): CoachRawReply {
  const trimmed = raw.trim();
  if (!trimmed) return emptyReply('');

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return toRawReply(parsed, '');
      }
    } catch {
      // Fall through to fenced-block or plain-text handling.
    }
  }

  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  if (fence && fence[1]) {
    const prose = trimmed.slice(0, fence.index).trim();
    try {
      const parsed: unknown = JSON.parse(fence[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return toRawReply(parsed, prose);
      }
    } catch {
      // Malformed JSON fence: return only the prose before the fence so raw JSON never leaks.
      if (prose) return emptyReply(prose);
    }
  }

  return emptyReply(trimmed);
}

/**
 * Extracts the decoded string value of `"text": "..."` from a possibly incomplete JSON object.
 * Used to stream Codex's structured JSON reply live before the turn completes.
 */
export function extractPartialJsonText(json: string): string {
  const keyMatch = /"text"\s*:\s*"/.exec(json);
  if (!keyMatch) return '';
  let out = '';
  let i = keyMatch.index + keyMatch[0].length;
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === '"') break;
    if (ch === '\\') {
      if (i + 1 >= json.length) break;
      const next = json[i + 1]!;
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === '"' || next === '\\' || next === '/') out += next;
      else if (next === 'u') {
        if (i + 5 >= json.length) break;
        const hex = json.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
        i += 4;
      } else {
        out += next;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
