/**
 * A small, muted explanation shown next to an action the current user appears to
 * lack permission (or plan entitlement) for.
 *
 * This is a UX HINT ONLY. Hiding or disabling an action is a convenience, not a
 * security boundary: the backend independently authorizes every request and
 * remains the sole authority. Pages still call the API and still render the
 * resulting FORBIDDEN / ENTITLEMENT_REQUIRED error if a guess is wrong.
 */
export function PermissionNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="muted" style={{ fontSize: '0.85rem', margin: '0.35rem 0 0' }}>
      {children}
    </p>
  );
}
