/**
 * @description
 * The character encoding an SMS is billed under.
 *
 * `GSM-7` is the 7-bit alphabet every network supports. Anything outside it — Cyrillic,
 * most notably — forces the whole message to `UCS-2`, which more than halves how much
 * fits in one segment.
 */
export type SmsEncoding = 'GSM-7' | 'UCS-2';

/**
 * @description
 * What a message costs to send, as reported by {@link countSegments}.
 */
export interface SmsSegmentInfo {
  /** The encoding the message is billed under. */
  encoding: SmsEncoding;
  /** Billable units: septets for `GSM-7`, UTF-16 code units for `UCS-2`. */
  length: number;
  /** How many segments the message is split into, and therefore how many you pay for. */
  segments: number;
  /** How much more fits before another segment is billed. */
  remaining: number;
}

const LIMITS: Record<SmsEncoding, { single: number; concatenated: number }> = {
  // A concatenated message spends 7 of its septets on the segmentation header.
  'GSM-7': { single: 160, concatenated: 153 },
  'UCS-2': { single: 70, concatenated: 67 },
};

/** GSM 03.38 basic character set — one septet each. */
// prettier-ignore
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

/** GSM 03.38 extension table — an escape plus the character, so two septets each. */
const GSM_EXTENDED = new Set('\f^{}\\[~]|€');

/**
 * @description
 * Works out the encoding and segment count of a message, which is what TurboSMS bills by.
 *
 * This matters more than it looks for a Ukrainian sender: one Cyrillic character forces
 * the whole message to `UCS-2`, where a segment holds **70** characters instead of 160.
 * A 75-character message costs two segments, not one.
 *
 * @example
 * ```ts
 * countSegments('Your code is 1234');
 * // { encoding: 'GSM-7', length: 17, segments: 1, remaining: 143 }
 *
 * countSegments('Ваш код 1234');
 * // { encoding: 'UCS-2', length: 12, segments: 1, remaining: 58 }
 * ```
 */
export function countSegments(text: string): SmsSegmentInfo {
  const septets = countSeptets(text);
  const encoding: SmsEncoding = septets === undefined ? 'UCS-2' : 'GSM-7';
  // UCS-2 is billed per 16-bit unit, so a character outside the BMP counts twice.
  const length = septets ?? text.length;
  const { single, concatenated } = LIMITS[encoding];

  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / concatenated);
  const capacity = segments <= 1 ? single : segments * concatenated;

  return { encoding, length, segments, remaining: capacity - length };
}

/**
 * The number of septets `text` occupies in GSM-7, or `undefined` when it contains a
 * character the alphabet cannot represent and the message therefore goes out as UCS-2.
 */
function countSeptets(text: string): number | undefined {
  let total = 0;
  for (const char of text) {
    if (GSM_BASIC.has(char)) {
      total += 1;
    } else if (GSM_EXTENDED.has(char)) {
      total += 2;
    } else {
      return undefined;
    }
  }
  return total;
}
