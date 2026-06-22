/** Fallback page for unknown routes in the foundation shell. */
export function NotFoundPage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '3rem auto', padding: '0 1rem' }}>
      <h1>Not found</h1>
      <p>
        No page is registered for this path. <a href="/">Return to status</a>.
      </p>
    </main>
  );
}
