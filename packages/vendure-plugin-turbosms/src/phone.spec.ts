import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from './phone';

describe('normalizePhoneNumber', () => {
  it('strips the separators a storefront collects', () => {
    expect(normalizePhoneNumber('+38 (050) 123-45-67')).toBe('380501234567');
    expect(normalizePhoneNumber('380 50 123 45 67')).toBe('380501234567');
  });

  it('drops a leading international access code', () => {
    expect(normalizePhoneNumber('00380501234567')).toBe('380501234567');
  });

  it('leaves an already-normalized number untouched', () => {
    expect(normalizePhoneNumber('380501234567')).toBe('380501234567');
  });

  it('leaves a national number as it was rather than guessing a country', () => {
    expect(normalizePhoneNumber('0501234567')).toBe('0501234567');
    expect(normalizePhoneNumber('(050) 123-45-67')).toBe('0501234567');
  });

  it('returns the digits it found rather than validating', () => {
    expect(normalizePhoneNumber('not a phone')).toBe('');
  });
});
