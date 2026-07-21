import { describe, expect, it } from 'vitest';
import {
  generateRequestId,
  isSafeRequestId,
  resolveRequestId,
  REQUEST_ID_MAX_LENGTH,
} from './request-id';

describe('generateRequestId', () => {
  it('produces a prefixed, unique id', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a.startsWith('req_')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('generates ids that satisfy the accepted inbound format', () => {
    expect(isSafeRequestId(generateRequestId())).toBe(true);
  });
});

describe('resolveRequestId', () => {
  it('preserves a well-formed inbound header value', () => {
    expect(resolveRequestId('req_inbound')).toBe('req_inbound');
    expect(resolveRequestId('trace-1.segment_2')).toBe('trace-1.segment_2');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveRequestId(['req_first', 'req_second'])).toBe('req_first');
  });

  it('generates a fresh id when the header is missing or empty', () => {
    expect(resolveRequestId(undefined).startsWith('req_')).toBe(true);
    expect(resolveRequestId('').startsWith('req_')).toBe(true);
  });

  it('replaces whitespace-bearing values instead of trimming them', () => {
    const resolved = resolveRequestId('  req_padded  ');
    expect(resolved.startsWith('req_')).toBe(true);
    expect(resolved).not.toContain('padded');
  });

  it('replaces values above the maximum accepted length', () => {
    const overlong = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);
    const resolved = resolveRequestId(overlong);
    expect(resolved).not.toBe(overlong);
    expect(resolved.startsWith('req_')).toBe(true);
  });

  it('accepts a value exactly at the maximum length', () => {
    const atLimit = 'a'.repeat(REQUEST_ID_MAX_LENGTH);
    expect(resolveRequestId(atLimit)).toBe(atLimit);
  });

  it.each([
    ['carriage return', 'req_a\rSet-Cookie:x'],
    ['line feed', 'req_a\nforged log line'],
    ['CRLF header injection', 'req_a\r\nX-Injected: 1'],
    ['NUL byte', 'req_a\u0000b'],
    ['control character', 'req_a\u0007b'],
    ['unsafe punctuation', 'req_a;DROP'],
  ])('replaces a value containing %s', (_label, hostile) => {
    const resolved = resolveRequestId(hostile);
    expect(resolved).not.toBe(hostile);
    expect(resolved.startsWith('req_')).toBe(true);
    expect(isSafeRequestId(resolved)).toBe(true);
  });
});
