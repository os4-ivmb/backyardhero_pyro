// Blob store interface for show audio (Cloud Builder plan §3.3).
//
//   local (fs)      -> public/uploads/audio/<filename>, served by
//                      /api/shows/audio/[filename] with range support.
//   cloud (supabase)-> Storage bucket, object key audio/<userId>/<uuid>.<ext>,
//                      served via signed URLs (added in Phase 1.2).
//
// The Show.audio_file column keeps storing *references* (key + url), so the
// data model is unchanged regardless of backend.
//
// Interface (all async):
//   put({ tmpPath, originalName }) -> { key, url, filename, size? }
//   getUrl(key)                    -> string (playable URL)
//   delete(key)                    -> void
//   openForServe(key)              -> { path, size } | null   (fs only; the
//        cloud serve path is a signed-URL redirect, not a byte stream)

import { caps } from '@/util/profile';

// ---------------------------------------------------------------------------
// fs implementation (local profile) — mirrors the pre-refactor behavior of
// upload-audio.js / audio/[filename].js exactly.
// ---------------------------------------------------------------------------
function createFsBlobStore() {
  // Lazy-require so the cloud build never pulls Node fs/path into a context
  // that selects the supabase store. (They're always available under Node,
  // but keeping the shape parallel with the DB adapter is intentional.)
  const fs = require('fs');
  const path = require('path');

  // Under Docker/Pi the app's own public/uploads/audio is used (unchanged).
  // In the desktop bundle the app dir is read-only (e.g. inside a macOS
  // .app), so when the supervisor sets BYH_DATA_DIR we store uploads under
  // that writable per-user data dir instead. The serve route uses this same
  // store, so reads and writes stay consistent.
  const AUDIO_DIR = process.env.BYH_DATA_DIR
    ? path.join(process.env.BYH_DATA_DIR, 'uploads', 'audio')
    : path.join(process.cwd(), 'public', 'uploads', 'audio');

  function ensureDir() {
    if (!fs.existsSync(AUDIO_DIR)) {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
    }
  }

  return {
    kind: 'fs',

    async put({ tmpPath, originalName }) {
      ensureDir();
      // Unique filename to avoid conflicts (timestamp prefix), identical to
      // the original upload route.
      const timestamp = Date.now();
      const base = path.basename(originalName || 'audio');
      const filename = `${timestamp}_${base}`;
      const finalPath = path.join(AUDIO_DIR, filename);
      fs.renameSync(tmpPath, finalPath);
      const size = fs.statSync(finalPath).size;
      return {
        key: filename,
        filename,
        url: this.getUrl(filename),
        size,
      };
    },

    getUrl(key) {
      return `/api/shows/audio/${encodeURIComponent(key)}`;
    },

    async delete(key) {
      const safe = path.basename(key || '');
      if (!safe) return;
      const p = path.join(AUDIO_DIR, safe);
      if (!p.startsWith(AUDIO_DIR + path.sep)) return;
      try { await fs.promises.unlink(p); } catch { /* best effort */ }
    },

    openForServe(key) {
      const safe = path.basename(key || '');
      if (!safe || safe !== key) return null;
      const p = path.join(AUDIO_DIR, safe);
      if (!p.startsWith(AUDIO_DIR + path.sep) || !fs.existsSync(p)) return null;
      const stat = fs.statSync(p);
      return { path: p, size: stat.size };
    },
  };
}

let _store = null;

/**
 * Resolve the blob store for the current deployment profile. Memoized.
 * The supabase implementation is dynamically required in Phase 1.2 so the
 * local build never imports @supabase/* code.
 */
export function getBlobStore() {
  if (_store) return _store;
  if (caps.audioStore === 'supabase') {
    // eslint-disable-next-line global-require
    const { createSupabaseBlobStore } = require('./supabaseBlobStore');
    _store = createSupabaseBlobStore();
  } else {
    _store = createFsBlobStore();
  }
  return _store;
}
