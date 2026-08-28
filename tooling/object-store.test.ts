/**
 * S3-compatible object-store client contract (Sprint 28, ORG-PR-005).
 *
 * Signing is verified against the two request-signing examples published in the
 * AWS Signature Version 4 documentation. That matters more than a self-consistent
 * golden file: a signing bug surfaces at the provider as an opaque HTTP 403 with
 * no indication of which of the eight canonicalisation rules was broken, so the
 * check has to come from outside this repository.
 *
 * Everything else is exercised through an injected fetch, because the behaviour
 * under test is what the client SENDS and how it interprets what comes back —
 * not whether a network is reachable.
 */
import { describe, expect, it } from 'vitest';

import {
  createObjectStore,
  encodeObjectKey,
  encodeRfc3986,
  parseListObjectsResponse,
  signRequest,
} from './lib/object-store.mjs';

const AWS_EXAMPLE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
};

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('AWS SigV4 published examples', () => {
  it('reproduces the documented GET Object signature', () => {
    const { authorization } = signRequest({
      method: 'GET',
      path: '/test.txt',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
      payloadSha256: EMPTY_SHA256,
      ...AWS_EXAMPLE_CREDENTIALS,
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('reproduces the documented PUT Object signature', () => {
    const { authorization } = signRequest({
      method: 'PUT',
      path: '/test%24file.text',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadSha256: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      ...AWS_EXAMPLE_CREDENTIALS,
    });
    expect(authorization).toContain(
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('never places the secret key in the Authorization header', () => {
    const { authorization } = signRequest({
      method: 'GET',
      path: '/test.txt',
      headers: { host: 'examplebucket.s3.amazonaws.com' },
      payloadSha256: EMPTY_SHA256,
      ...AWS_EXAMPLE_CREDENTIALS,
    });
    expect(authorization).not.toContain(AWS_EXAMPLE_CREDENTIALS.secretAccessKey);
  });
});

describe('URI encoding', () => {
  it('escapes the characters encodeURIComponent leaves alone', () => {
    expect(encodeRfc3986("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
  });

  it('encodes a key segment-wise, keeping / as a separator', () => {
    expect(encodeObjectKey('staging-like/logical/test$file.text')).toBe(
      'staging-like/logical/test%24file.text',
    );
  });
});

describe('parseListObjectsResponse', () => {
  it('reads every Contents entry', () => {
    const parsed = parseListObjectsResponse(`<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents><Key>a/one.enc</Key><Size>120</Size><LastModified>2026-08-27T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents>
        <Contents><Key>a/two.enc</Key><Size>240</Size><LastModified>2026-08-27T11:00:00.000Z</LastModified><ETag>&quot;def&quot;</ETag></Contents>
      </ListBucketResult>`);
    expect(parsed.objects).toEqual([
      { key: 'a/one.enc', size: 120, lastModified: '2026-08-27T10:00:00.000Z', etag: 'abc' },
      { key: 'a/two.enc', size: 240, lastModified: '2026-08-27T11:00:00.000Z', etag: 'def' },
    ]);
    expect(parsed.continuationToken).toBe('');
  });

  it('reports a continuation token only while the listing is truncated', () => {
    const truncated = parseListObjectsResponse(
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>',
    );
    expect(truncated.continuationToken).toBe('tok');
    expect(
      parseListObjectsResponse('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
        .continuationToken,
    ).toBe('');
  });

  it('returns nothing for an empty bucket rather than throwing', () => {
    expect(parseListObjectsResponse('<ListBucketResult></ListBucketResult>').objects).toEqual([]);
  });
});

type Recorded = { url: string; method: string; headers: Record<string, string> };

function storeWithRecorder(responses: Response[], overrides: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  let index = 0;
  const store = createObjectStore({
    endpoint: 'https://ams3.digitaloceanspaces.com',
    region: 'ams3',
    bucket: 'orgistry-backups',
    accessKeyId: 'SPACES-KEY-ID',
    secretAccessKey: 'spaces-secret-value',
    prefix: 'staging-like',
    now: () => new Date(Date.UTC(2026, 7, 27, 11, 30, 0)),
    fetchImplementation: async (url: URL, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)),
      });
      return responses[Math.min(index++, responses.length - 1)];
    },
    ...overrides,
  });
  return { store, calls };
}

describe('createObjectStore', () => {
  it('refuses to be built without every required credential field', () => {
    expect(() =>
      createObjectStore({ endpoint: 'https://x', region: 'r', bucket: 'b', accessKeyId: '', secretAccessKey: 's' }),
    ).toThrow(/missing accessKeyId/);
  });

  it('namespaces keys with the configured prefix', () => {
    const { store } = storeWithRecorder([new Response('', { status: 200 })]);
    expect(store.keyFor('logical/x.enc')).toBe('staging-like/logical/x.enc');
  });

  it('describes the target without any credential', () => {
    const { store } = storeWithRecorder([new Response('', { status: 200 })]);
    const described = store.describeTarget();
    expect(described).toEqual({
      endpoint: 'https://ams3.digitaloceanspaces.com',
      region: 'ams3',
      bucket: 'orgistry-backups',
      prefix: 'staging-like',
      addressing: 'path',
    });
    expect(JSON.stringify(described)).not.toContain('spaces-secret-value');
  });

  it('uses path-style addressing and header authentication, never a presigned URL', async () => {
    const { store, calls } = storeWithRecorder([new Response('', { status: 200 })]);
    await store.putBuffer('catalog.json', Buffer.from('{}'));
    expect(calls[0].url).toBe(
      'https://ams3.digitaloceanspaces.com/orgistry-backups/staging-like/catalog.json',
    );
    expect(calls[0].url).not.toContain('X-Amz-Signature');
    expect(calls[0].headers.authorization).toContain('Credential=SPACES-KEY-ID/20260827/ams3/s3/aws4_request');
    expect(JSON.stringify(calls[0])).not.toContain('spaces-secret-value');
  });

  it('supports virtual-host addressing for providers that require it', async () => {
    const { store, calls } = storeWithRecorder([new Response('', { status: 200 })], { forcePathStyle: false });
    await store.putBuffer('catalog.json', Buffer.from('{}'));
    expect(calls[0].url).toBe(
      'https://orgistry-backups.ams3.digitaloceanspaces.com/staging-like/catalog.json',
    );
  });

  it('treats a missing object as absent, not as an error', async () => {
    const { store } = storeWithRecorder([new Response('', { status: 404 })]);
    await expect(store.headObject('logical/gone.enc')).resolves.toBeNull();
  });

  it('reports the provider diagnosis when a request is rejected', async () => {
    const { store } = storeWithRecorder([
      new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 }),
    ]);
    await expect(store.putBuffer('x.json', Buffer.from('{}'))).rejects.toThrow(
      /PUT x.json failed: HTTP 403 .*SignatureDoesNotMatch/,
    );
  });

  it('follows continuation tokens until the listing is complete', async () => {
    const { store, calls } = storeWithRecorder([
      new Response(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken>' +
          '<Contents><Key>staging-like/a</Key><Size>1</Size><LastModified>t</LastModified><ETag>e</ETag></Contents>' +
          '</ListBucketResult>',
        { status: 200 },
      ),
      new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>staging-like/b</Key><Size>2</Size><LastModified>t</LastModified><ETag>e</ETag></Contents>' +
          '</ListBucketResult>',
        { status: 200 },
      ),
    ]);
    const found = await store.list('');
    expect(found.map((object) => object.key)).toEqual(['staging-like/a', 'staging-like/b']);
    expect(calls[1].url).toContain('continuation-token=page2');
  });

  it('retries a transport failure and succeeds — the DigitalOcean VPC endpoint case', async () => {
    // Observed on the real target: the Spaces endpoint resolves to a
    // VPC-internal address that intermittently refuses TCP connections.
    let attempts = 0;
    const store = createObjectStore({
      endpoint: 'https://fra1.digitaloceanspaces.com',
      region: 'fra1',
      bucket: 'orgistry-staging-backups',
      accessKeyId: 'KEY',
      secretAccessKey: 'secret',
      prefix: 'orgistry/staging-like',
      retryDelayMs: 5,
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: new Error('connect ECONNREFUSED 10.114.15.254:443'),
          });
        }
        return new Response('', { status: 200 });
      },
    });
    await expect(store.putBuffer('wal/000000010000000000000017.enc', Buffer.from('x'))).resolves.toMatchObject({
      key: 'orgistry/staging-like/wal/000000010000000000000017.enc',
    });
    expect(attempts).toBe(3);
  });

  it('rebuilds the body on each attempt, so a stream upload can be retried', async () => {
    const bodies: unknown[] = [];
    let attempts = 0;
    const store = createObjectStore({
      endpoint: 'https://fra1.digitaloceanspaces.com',
      region: 'fra1',
      bucket: 'b',
      accessKeyId: 'KEY',
      secretAccessKey: 'secret',
      retryDelayMs: 5,
      fetchImplementation: async (_url: URL, init: RequestInit) => {
        attempts += 1;
        bodies.push(init.body);
        if (attempts < 2) throw new TypeError('fetch failed');
        return new Response('', { status: 200 });
      },
    });
    await store.putBuffer('k.json', Buffer.from('{}'));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBeUndefined();
    expect(bodies[1]).not.toBeUndefined();
  });

  it('gives up after a bounded number of transport attempts rather than hanging', async () => {
    let attempts = 0;
    const store = createObjectStore({
      endpoint: 'https://fra1.digitaloceanspaces.com',
      region: 'fra1',
      bucket: 'b',
      accessKeyId: 'KEY',
      secretAccessKey: 'secret',
      // A tiny window so exhaustion is exercised without waiting out the real one.
      retryWindowMs: 30,
      retryDelayMs: 5,
      retryMaxAttempts: 4,
      fetchImplementation: async () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
    });
    await expect(store.putBuffer('k.json', Buffer.from('{}'))).rejects.toThrow(/fetch failed/);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it('never retries an HTTP status — a 403 is an answer, not a transport failure', async () => {
    let attempts = 0;
    const store = createObjectStore({
      endpoint: 'https://fra1.digitaloceanspaces.com',
      region: 'fra1',
      bucket: 'b',
      accessKeyId: 'KEY',
      secretAccessKey: 'secret',
      fetchImplementation: async () => {
        attempts += 1;
        return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
      },
    });
    await expect(store.putBuffer('k.json', Buffer.from('{}'))).rejects.toThrow(/SignatureDoesNotMatch/);
    expect(attempts).toBe(1);
  });

  it('accepts a DELETE of an object that is already gone', async () => {
    const { store } = storeWithRecorder([new Response('', { status: 404 })]);
    await expect(store.deleteObject('logical/gone.enc')).resolves.toEqual({
      key: 'staging-like/logical/gone.enc',
    });
  });
});
