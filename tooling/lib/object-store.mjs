/**
 * Minimal S3-compatible object-store client (Sprint 28, ORG-PR-005).
 *
 * WHY THIS EXISTS INSTEAD OF AN SDK OR A CLI
 * The deployment target deliberately carries no application source, no package
 * manager, and no npm dependency closure — Sprint 27 established that the whole
 * operational toolchain transferred to the host is a handful of files using
 * only Node built-ins, and installing an AWS CLI or an SDK there would give
 * that up for one HTTP call shape. This module signs requests with AWS
 * Signature Version 4 using `node:crypto` and sends them with `fetch`, so the
 * same code runs on the host, on a laptop, and in CI with nothing installed.
 *
 * It implements exactly the five operations the backup programme needs — put,
 * get, head, list, delete — and nothing else. It is not a general S3 client and
 * should not grow into one.
 *
 * PORTABILITY
 * Signing is provider-neutral: DigitalOcean Spaces, AWS S3, Cloudflare R2,
 * Backblaze B2's S3 API, and MinIO all accept it. Path-style addressing is the
 * default because it is the form every one of them supports.
 *
 * CREDENTIAL HANDLING
 *   * The secret access key is used only as an HMAC key. It is never placed in
 *     a URL, a query string, a log line, or an error message.
 *   * Requests are authenticated with the `Authorization` HEADER, never with a
 *     presigned URL, so a credential can never end up in a proxy log, a shell
 *     history, or captured evidence.
 *   * `describeTarget()` returns the non-secret identity (endpoint, region,
 *     bucket, prefix) that operator evidence is allowed to record.
 */

import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Bounded retry for TRANSPORT failures only.
 *
 * WHY THIS EXISTS
 * Measured on the DigitalOcean staging target: `fra1.digitaloceanspaces.com`
 * resolves to a VPC-internal address — every resolver returns it, so there is
 * no alternate public endpoint to prefer — which refuses roughly **half** of
 * all TCP connects. A 90-sample probe using a raw socket, entirely outside this
 * code, saw **47 of 90 connects refused (52%)**, in bursts of at most **3
 * seconds**.
 *
 * A client with no retry at all was the real defect here: every production S3
 * client retries transport failures by default, which is why the AWS CLI talks
 * to this same endpoint without trouble. Without it, a large share of every
 * scheduled WAL shipment and backup upload fails, turning a healthy environment
 * red and — through the deployment protection preflight — blocking deployments.
 *
 * SIZING
 * The retry window is set well beyond the longest observed burst rather than
 * from an attempt count, because the refusals are correlated in time: what
 * matters is covering the burst, not the number of tries. A short fixed delay
 * suits short bursts better than exponential backoff, which would spend most of
 * the window asleep.
 *
 * SCOPE — deliberately narrow
 * It covers only the case where NO HTTP response was produced: nothing was
 * answered, so the request can be re-sent safely. An HTTP status — 403, 404,
 * 409 — is an ANSWER and is never retried; those must keep failing closed.
 * When the window expires the error is still raised, so a genuine outage is
 * never masked into silence.
 */
const TRANSPORT_RETRY_WINDOW_MS = 10_000;
const TRANSPORT_RETRY_DELAY_MS = 400;
const TRANSPORT_RETRY_MAX_ATTEMPTS = 30;

const SIGNING_ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

/**
 * RFC 3986 encoding as S3 canonicalisation requires it.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, which produces a canonical
 * request the server will not reproduce — a signature mismatch that only shows
 * up on object keys containing those characters. Encoding them explicitly is
 * cheaper than debugging that later.
 */
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key for a URL path, preserving `/` as a separator. */
export function encodeObjectKey(key) {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** `20260827T113045Z` and `20260827` — the two forms SigV4 needs. */
export function amazonDateStamps(date) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function buildCanonicalRequest({ method, path, query, headers, payloadSha256 }) {
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name])}`)
    .join('&');

  const lowercased = Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    String(value).trim().replace(/\s+/g, ' '),
  ]);
  lowercased.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const canonicalHeaders = lowercased.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = lowercased.map(([name]) => name).join(';');

  return {
    canonicalRequest: [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadSha256].join('\n'),
    signedHeaders,
  };
}

function deriveSigningKey(secretAccessKey, dateStamp, region) {
  const date = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const regional = createHmac('sha256', date).update(region).digest();
  const service = createHmac('sha256', regional).update(SERVICE).digest();
  return createHmac('sha256', service).update('aws4_request').digest();
}

/**
 * Produce the `Authorization` header value for one request.
 *
 * Exported so it can be tested directly against a published AWS SigV4 vector —
 * signing is the one part of this module whose failure mode is an opaque 403
 * rather than an obvious error.
 */
export function signRequest({
  method,
  path,
  query = {},
  headers,
  payloadSha256,
  accessKeyId,
  secretAccessKey,
  region,
  date,
}) {
  const { amzDate, dateStamp } = amazonDateStamps(date);
  const signedHeaderSet = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256 };
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    path,
    query,
    headers: signedHeaderSet,
    payloadSha256,
  });

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    SIGNING_ALGORITHM,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signature = createHmac('sha256', deriveSigningKey(secretAccessKey, dateStamp, region))
    .update(stringToSign)
    .digest('hex');

  return {
    amzDate,
    authorization:
      `${SIGNING_ALGORITHM} Credential=${accessKeyId}/${scope},` +
      `SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/** Extract every `<Contents>` entry from a ListObjectsV2 response. */
export function parseListObjectsResponse(xml) {
  const read = (block, tag) => {
    const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1] : '';
  };
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
    key: read(block, 'Key'),
    size: Number(read(block, 'Size') || 0),
    lastModified: read(block, 'LastModified'),
    etag: read(block, 'ETag').replace(/(^"|"$|^&quot;|&quot;$)/g, ''),
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const continuationToken = truncated ? read(xml, 'NextContinuationToken') : '';
  return { objects, continuationToken };
}

/**
 * Build an object-store client.
 *
 * `prefix` namespaces every key, so one bucket can hold more than one
 * environment's backups without them being able to collide.
 */
export function createObjectStore({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  prefix = '',
  forcePathStyle = true,
  fetchImplementation = fetch,
  now = () => new Date(),
  // Overridable so tests can exercise exhaustion without waiting out the real
  // window. Production callers never set these.
  retryWindowMs = TRANSPORT_RETRY_WINDOW_MS,
  retryDelayMs = TRANSPORT_RETRY_DELAY_MS,
  retryMaxAttempts = TRANSPORT_RETRY_MAX_ATTEMPTS,
}) {
  for (const [name, value] of Object.entries({ endpoint, region, bucket, accessKeyId, secretAccessKey })) {
    if (!value) throw new Error(`object store configuration is missing ${name}`);
  }

  const base = new URL(endpoint);
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');

  const resolveKey = (key) => (normalizedPrefix ? `${normalizedPrefix}/${key}` : key);

  function buildRequestTarget(fullKey) {
    if (forcePathStyle) {
      return {
        host: base.host,
        path: `/${bucket}${fullKey ? `/${encodeObjectKey(fullKey)}` : ''}`,
        origin: base.origin,
      };
    }
    const host = `${bucket}.${base.host}`;
    return { host, path: `/${fullKey ? encodeObjectKey(fullKey) : ''}`, origin: `${base.protocol}//${host}` };
  }

  /**
   * `makeBody` is a FACTORY, not a body. A file upload's body is a stream that
   * can be consumed exactly once, so a retry has to build a fresh one; taking a
   * factory makes that impossible to get wrong at a call site.
   */
  async function send({ method, fullKey, query = {}, payloadSha256, makeBody, extraHeaders = {}, contentLength }) {
    const { host, path, origin } = buildRequestTarget(fullKey);
    const headers = { host, ...extraHeaders };
    if (contentLength !== undefined) headers['content-length'] = String(contentLength);

    const url = new URL(origin + path);
    for (const name of Object.keys(query).sort()) url.searchParams.set(name, query[name]);

    let lastTransportError;
    const retryDeadline = Date.now() + retryWindowMs;
    for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
      // Each attempt is signed afresh: the signature is bound to its own
      // timestamp, and a re-sent request must not carry a stale one.
      const { amzDate, authorization } = signRequest({
        method,
        path,
        query,
        headers,
        payloadSha256,
        accessKeyId,
        secretAccessKey,
        region,
        date: now(),
      });

      const body = makeBody ? makeBody() : undefined;
      try {
        return await fetchImplementation(url, {
          method,
          headers: {
            ...headers,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadSha256,
            authorization,
          },
          body,
          duplex: body ? 'half' : undefined,
        });
      } catch (error) {
        // No HTTP response was produced, so the request was never answered.
        lastTransportError = error;
        if (attempt === retryMaxAttempts || Date.now() + retryDelayMs > retryDeadline) break;
        await sleep(retryDelayMs);
      }
    }
    throw lastTransportError;
  }

  /**
   * Turn a non-2xx response into an actionable error.
   *
   * The provider's XML error body is included because it names the actual cause
   * ("SignatureDoesNotMatch", "NoSuchBucket", "AccessDenied") and contains no
   * credential — but it is truncated, because an unbounded remote string in an
   * operator's terminal is its own problem.
   */
  async function failure(operation, key, response) {
    let detail = '';
    try {
      detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 400);
    } catch {
      detail = '(no response body)';
    }
    return new Error(`${operation} ${key || '(bucket)'} failed: HTTP ${response.status} ${detail}`);
  }

  return {
    describeTarget() {
      return { endpoint: base.origin, region, bucket, prefix: normalizedPrefix, addressing: forcePathStyle ? 'path' : 'virtual-host' };
    },

    keyFor: resolveKey,

    /** Upload a file whose SHA-256 the caller has already computed. */
    async putFile(key, filePath, { contentSha256, contentLength, contentType = 'application/octet-stream' }) {
      const response = await send({
        method: 'PUT',
        fullKey: resolveKey(key),
        payloadSha256: contentSha256,
        makeBody: () => Readable.toWeb(createReadStream(filePath)),
        contentLength,
        extraHeaders: { 'content-type': contentType },
      });
      if (!response.ok) throw await failure('PUT', key, response);
      await response.arrayBuffer();
      return { key: resolveKey(key), bytes: contentLength };
    },

    /** Upload a small in-memory body (catalog documents, markers). */
    async putBuffer(key, buffer, { contentType = 'application/json' } = {}) {
      const payloadSha256 = createHash('sha256').update(buffer).digest('hex');
      const response = await send({
        method: 'PUT',
        fullKey: resolveKey(key),
        payloadSha256,
        makeBody: () => buffer,
        contentLength: buffer.length,
        extraHeaders: { 'content-type': contentType },
      });
      if (!response.ok) throw await failure('PUT', key, response);
      await response.arrayBuffer();
      return { key: resolveKey(key), bytes: buffer.length };
    },

    async getFile(key, destinationPath) {
      const response = await send({ method: 'GET', fullKey: resolveKey(key), payloadSha256: EMPTY_PAYLOAD_SHA256 });
      if (!response.ok) throw await failure('GET', key, response);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath, { mode: 0o600 }));
      return { key: resolveKey(key) };
    },

    async getText(key) {
      const response = await send({ method: 'GET', fullKey: resolveKey(key), payloadSha256: EMPTY_PAYLOAD_SHA256 });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('GET', key, response);
      return response.text();
    },

    /** `null` when the object does not exist — absence is an answer, not an error. */
    async headObject(key) {
      const response = await send({ method: 'HEAD', fullKey: resolveKey(key), payloadSha256: EMPTY_PAYLOAD_SHA256 });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('HEAD', key, response);
      return {
        key: resolveKey(key),
        bytes: Number(response.headers.get('content-length') ?? 0),
        lastModified: response.headers.get('last-modified') ?? '',
      };
    },

    /** Every object under a prefix, following continuation tokens to the end. */
    async list(keyPrefix = '') {
      const fullPrefix = resolveKey(keyPrefix);
      const found = [];
      let continuationToken = '';
      do {
        const query = { 'list-type': '2', prefix: fullPrefix, 'max-keys': '1000' };
        if (continuationToken) query['continuation-token'] = continuationToken;
        const response = await send({ method: 'GET', fullKey: '', query, payloadSha256: EMPTY_PAYLOAD_SHA256 });
        if (!response.ok) throw await failure('LIST', fullPrefix, response);
        const parsed = parseListObjectsResponse(await response.text());
        found.push(...parsed.objects);
        continuationToken = parsed.continuationToken;
      } while (continuationToken);
      return found;
    },

    async deleteObject(key) {
      const response = await send({ method: 'DELETE', fullKey: resolveKey(key), payloadSha256: EMPTY_PAYLOAD_SHA256 });
      // S3 DELETE is idempotent: 204 for a delete, 404 for an object that was
      // already gone. Both mean "it is not there", which is what was asked for.
      if (!response.ok && response.status !== 404) throw await failure('DELETE', key, response);
      await response.arrayBuffer();
      return { key: resolveKey(key) };
    },
  };
}
