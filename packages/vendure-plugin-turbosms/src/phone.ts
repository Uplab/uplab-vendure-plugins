/**
 * @description
 * Puts a phone number into the format TurboSMS accepts: digits only, no leading `+` —
 * e.g. `380501234567`.
 *
 * Storefronts collect phone numbers in whatever shape the customer typed, so this strips
 * the decoration off an international number:
 *
 * 1. Everything that is not a digit is dropped, `+` and separators included.
 * 2. A leading `00` — the international access code, the written form of `+` — is dropped.
 *
 * Both steps are lossless: they remove notation, never add anything. In particular a
 * national number (`0501234567`) is **not** expanded to an international one, because
 * which country it belongs to is not something this plugin can know — see the README for
 * how to do that in your application, where the answer is known.
 *
 * It does not validate either: a string that is not a phone number comes back as whatever
 * digits it contained, and TurboSMS refuses it per recipient.
 *
 * @example
 * ```ts
 * normalizePhoneNumber('+38 (050) 123-45-67');  // '380501234567'
 * normalizePhoneNumber('00380501234567');       // '380501234567'
 * normalizePhoneNumber('0501234567');           // '0501234567' — left as it was
 * ```
 */
export function normalizePhoneNumber(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.startsWith('00') ? digits.slice(2) : digits;
}
