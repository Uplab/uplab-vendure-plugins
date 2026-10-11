const MARKER = ' … ';

/** The first characters of `text` that fit into `bytes` UTF-8 bytes, never splitting a character. */
function head(chars: string[], bytes: number): string {
  let used = 0;
  let out = '';
  for (const char of chars) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) {
      break;
    }
    used += size;
    out += char;
  }
  return out;
}

function tail(chars: string[], bytes: number): string {
  let used = 0;
  let index = chars.length;
  while (index > 0) {
    const size = Buffer.byteLength(chars[index - 1]);
    if (used + size > bytes) {
      break;
    }
    used += size;
    index--;
  }
  return chars.slice(index).join('');
}

/**
 * Caps a stored value at `maxBytes` (UTF-8). A longer string keeps its head and tail around a ` … ` marker;
 * any other value longer than the cap as JSON is stored as such a shortened JSON string.
 */
export function capValue(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (value === null || (typeof value !== 'string' && typeof value !== 'object')) {
    return { value, truncated: false };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) {
    return { value, truncated: false };
  }
  const half = Math.max(0, Math.floor((maxBytes - Buffer.byteLength(MARKER)) / 2));
  const chars = Array.from(text);
  return { value: `${head(chars, half)}${MARKER}${tail(chars, half)}`, truncated: true };
}

/** Caps every value of a flat state, e.g. the `lastState` of a deleted entity. */
export function capState(state: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    capped[key] = capValue(value, maxBytes).value;
  }
  return capped;
}
