import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  errorEnvelopeSchema,
  makeCursorPage,
  makeError,
  makeSuccess,
} from './index';

describe('envelopes', () => {
  it('wraps success data with ok: true', () => {
    const envelope = makeSuccess({ value: 1 });
    expect(envelope).toEqual({ ok: true, data: { value: 1 } });
  });

  it('builds an error envelope that includes the request id', () => {
    const envelope = makeError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'missing',
      requestId: 'req_123',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error.requestId).toBe('req_123');
    expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('omits details when not provided', () => {
    const envelope = makeError({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'boom',
      requestId: 'req_1',
    });
    expect('details' in envelope.error).toBe(false);
  });
});

describe('cursor pagination', () => {
  it('marks hasMore true when a next cursor exists', () => {
    const page = makeCursorPage([1, 2], 'cursor-abc');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('cursor-abc');
  });

  it('marks hasMore false on the final page', () => {
    const page = makeCursorPage([1, 2], null);
    expect(page.hasMore).toBe(false);
  });
});
