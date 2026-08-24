// Runtime public configuration fallback (Sprint 26 refinement).
//
// A DEPLOYED container never serves this file: apps/web-demo/nginx.conf.template
// declares an exact-match `location = /public-config.js` that renders the real
// configuration from container environment variables at startup, and an exact
// location match wins over static file serving.
//
// This copy exists so the Vite dev server and any plain static host still
// resolve the script tag in index.html. It sets NO values on purpose, so
// `pnpm dev:web` keeps falling through to VITE_* overrides and the built-in
// localhost defaults (apps/web-demo/src/public-config.ts).
//
// Never put a credential here. Everything in this object is served to every
// browser, and the application refuses to start if it sees a credential-shaped
// key.
window.__ORGISTRY_PUBLIC_CONFIG__ = {};
