import { describe, expect, it } from 'vitest';
import { formatRate } from './format-rate';

describe('formatRate', () => {
  it('keeps small rates readable in the list', () => {
    expect(formatRate('en', 0.00634217)).toBe('0.00634217');
    expect(formatRate('en', 1.32007574)).toBe('1.32008');
  });

  it('shows every stored decimal in full', () => {
    expect(formatRate('en', 1.32007574, 'full')).toBe('1.32007574');
    expect(formatRate('uk', 1.1225, 'full')).toBe('1,1225');
  });
});
