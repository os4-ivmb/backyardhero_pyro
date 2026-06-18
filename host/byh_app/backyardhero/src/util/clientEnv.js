// Client-safe build-time flags.
//
// Only NEXT_PUBLIC_* env vars are inlined into the browser bundle, so the
// server-side `profile.js` (which reads BYH_PROFILE) can't be used on the
// client. next.config.mjs maps the deploy profile onto these two vars at
// build time.
//
// For the local / on-device build these are unset, so BASE_PATH === '' and
// PROFILE === 'local' — i.e. identical behaviour to before this existed.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const PROFILE =
  process.env.NEXT_PUBLIC_BYH_PROFILE === 'cloud' ? 'cloud' : 'local';

// Hardware (on-device daemon, dongle, receivers) only exists in the local
// profile. The cloud builder is a pure show-authoring surface.
export const HARDWARE = PROFILE === 'local';

// Prefix an app-absolute path with the deploy basePath. Use for raw fetch()
// calls and any hand-built URL; next/link, next/router and next/image already
// apply basePath automatically. No-op locally (BASE_PATH === '').
export const apiUrl = (path) => `${BASE_PATH}${path}`;
