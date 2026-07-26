import { randomBytes } from 'node:crypto';

/**
 * Uniform random strings over a fixed alphabet.
 *
 * Mapping a CSPRNG byte into an alphabet with `byte % alphabet.length` is
 * unbiased ONLY when the alphabet length divides the 256-value byte domain
 * evenly. Otherwise the low residues occur more often than the high ones: with
 * a 30-character alphabet, for instance, bytes 0–15 map to residues 0–15 nine
 * times across 0–255 while the rest map eight times, so the first sixteen
 * characters are ~12.5% more likely than the others.
 *
 * Orgistry's alphabets are all 32 characters (Crockford base32), and
 * 256 = 32 × 8 exactly — every character is the image of precisely 8 of the
 * 256 byte values, so the mapping is perfectly uniform. That property is the
 * whole reason the modulo is safe here, which makes it an invariant rather
 * than a coincidence: {@link assertUniformAlphabet} enforces it at module load
 * so shortening or extending an alphabet to a non-divisor length fails loudly
 * instead of silently biasing generated values.
 *
 * Static analyzers (CodeQL `js/biased-cryptographic-random`) flag the modulo
 * on sight because they do not evaluate the divisibility precondition. Keeping
 * the operation in one asserted, documented place means that judgement has to
 * be made — and can be verified — exactly once.
 */

/** The byte domain a single `randomBytes` octet ranges over. */
const BYTE_DOMAIN_SIZE = 256;

/**
 * Throw unless `alphabet` can be sampled without modulo bias. Call this at
 * module scope next to the alphabet it guards, so a bad alphabet is a startup
 * failure rather than a subtly skewed identifier stream.
 */
export function assertUniformAlphabet(alphabet: string, label: string): void {
  if (alphabet.length === 0 || BYTE_DOMAIN_SIZE % alphabet.length !== 0) {
    throw new Error(
      `${label}: alphabet length ${alphabet.length} does not divide ${BYTE_DOMAIN_SIZE}, ` +
        'so modulo reduction would bias the output. Use a length that divides 256 ' +
        '(e.g. 32) or switch to rejection sampling.',
    );
  }
}

/**
 * Generate `length` characters drawn uniformly from `alphabet` using CSPRNG
 * bytes. `alphabet` MUST already satisfy {@link assertUniformAlphabet}; callers
 * assert it once at module scope rather than paying the check per call.
 */
export function randomAlphabetString(alphabet: string, length: number): string {
  let out = '';
  for (const byte of randomBytes(length)) {
    out += alphabet.charAt(byte % alphabet.length);
  }
  return out;
}
