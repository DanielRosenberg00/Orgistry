import { describe, expect, it } from 'vitest';
import { generateRequestId, resolveRequestId } from './request-id';

describe('generateRequestId', () => {
  it('produces a prefixed, unique id', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a.startsWith('req_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('resolveRequestId', () => {
  it('trusts a non-empty inbound header value', () => {
    expect(resolveRequestId('req_inbound')).toBe('req_inbound');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveRequestId(['req_first', 'req_second'])).toBe('req_first');
  });

  it('generates a fresh id when the header is missing or blank', () => {
    expect(resolveRequestId(undefined).startsWith('req_')).toBe(true);
    expect(resolveRequestId('   ').startsWith('req_')).toBe(true);
  });
});
