import { describe, expect, it } from 'vitest';
import { interpolate } from './interpolate';

describe('interpolate', () => {
  it('replaces every known placeholder', () => {
    expect(interpolate('Your {brand} code is {code}', { brand: 'MyShop', code: '1234' })).toBe(
      'Your MyShop code is 1234',
    );
  });

  it('leaves an unknown placeholder untouched', () => {
    expect(interpolate('Hi {name}, code {code}', { code: '1234' })).toBe('Hi {name}, code 1234');
  });

  it('does not pick up inherited object properties', () => {
    expect(interpolate('{toString}', {})).toBe('{toString}');
  });
});
