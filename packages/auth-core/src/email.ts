/**
 * Email normalization.
 *
 * Normalization is the single rule that backs the "one account per email"
 * invariant: the normalized form is what uniqueness is enforced on and what
 * login looks up by. It is intentionally conservative — trim surrounding
 * whitespace and lowercase — so it never merges addresses that providers treat
 * as distinct (e.g. it does NOT strip dots or `+tags`, which would over-merge
 * for some providers). The raw address the user typed is stored separately for
 * display.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
