import { describe, expect, it } from 'vitest';
import { effectiveRate } from './effective-rate';

describe('effectiveRate', () => {
  it('uses the fetched rate when the custom rate is off', () => {
    expect(effectiveRate({ rate: 41, useCustomRate: false, customRate: 45 })).toBe(41);
  });

  it('uses the custom rate while it is on', () => {
    expect(effectiveRate({ rate: 41, useCustomRate: true, customRate: 45 })).toBe(45);
  });

  it('is NaN rather than a guess when the custom rate is on but empty', () => {
    expect(effectiveRate({ rate: 41, useCustomRate: true, customRate: null })).toBeNaN();
  });
});
