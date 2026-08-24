import { describe, expect, it } from 'vitest';
import { type TurboSmsResponseResult } from '../types';
import { TurboSmsError } from './index';

function makeResult(overrides: Partial<TurboSmsResponseResult> = {}): TurboSmsResponseResult {
  return {
    phone: '380501234567',
    response_code: 0,
    response_status: 'OK',
    message_id: 'msg-1',
    ...overrides,
  };
}

describe('TurboSmsError', () => {
  describe('recipientCodes', () => {
    it('returns the response_code of every per-recipient result', () => {
      const error = new TurboSmsError(
        'text',
        202,
        'ACCEPTED',
        [
          makeResult({ phone: '380501111111', response_code: 406 }),
          makeResult({ phone: '380502222222', response_code: 203 }),
        ],
        ['380501111111', '380502222222'],
      );

      expect(error.recipientCodes).toEqual([406, 203]);
    });

    it('returns an empty array when there are no per-recipient results', () => {
      const error = new TurboSmsError('text', 202, 'ACCEPTED', [], []);

      expect(error.recipientCodes).toEqual([]);
    });
  });
});
