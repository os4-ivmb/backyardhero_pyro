// Blob store interface for user-uploaded binaries (Cloud Builder plan §3.3).
//
// Two "kinds" of blob share the same interface and storage roots:
//   audio  -> show pyromusical tracks (uploaded in the builder)
//   image  -> inventory item images (cakes / fountains / shells)
//
//   local (fs)      -> <root>/uploads/<kind>/<filename>, served by a per-kind
//                      route (audio: /api/shows/audio/[filename] with range;
//                      image: /api/inventory/image/[filename]).
//   cloud (supabase)-> Storage bucket, object key <kind>/<userId>/<uuid>.<ext>,
//                      served via signed URLs.
//
// The DB columns (Show.audio_file, inventory.image) keep storing *references*
// (a URL, and for audio a key), so the data model is unchanged regardless of
// backend.
//
// Interface (all async unless noted):
//   put({ tmpPath, originalName, mimetype, userId }) -> { key, url, filename, size? }
//   getUrl(key)                    -> string (playable / viewable URL)
//   delete(key)                    -> void
//   openForServe(key)              -> { path, size } | null   (fs only; the
//        cloud serve path is a signed-URL redirect, not a byte stream)

import { caps } from '@/util/profile';

// Per-kind layout. `subdir` is the folder under uploads/; `serveBase` is the
// app-absolute API path the fs store hands back as the stored URL.
const KIND_CONFIG = {
  audio: { subdir: 'audio', serveBase: '/api/shows/audio' },
  image: { subdir: 'images', serveBase: '/api/inventory/image' },
};

function kindConfig(kind) {
  return KIND_CONFIG[kind] || KIND_CONFIG.audio;
}

// ---------------------------------------------------------------------------
// fs implementation (local profile) — mirrors the pre-refactor behavior of
// upload-audio.js / audio/[filename].js exactly, parameterized by kind so the
// inventory image store lands in a sibling uploads/images folder.
// ---------------------------------------------------------------------------
function createFsBlobStore(kind) {
  // Lazy-require so the cloud build never pulls Node fs/path into a context
  // that selects the supabase store. (They're always available under Node,
  // but keeping the shape parallel with the DB adapter is intentional.)
  const fs = require('fs');
  const path = require('path');
  const cfg = kindConfig(kind);

  // Under Docker/Pi the app's own public/uploads/<kind> is used (unchanged).
  // In the desktop bundle the app dir is read-only (e.g. inside a macOS
  // .app), so when the supervisor sets BYH_DATA_DIR we store uploads under
  // that writable per-user data dir instead -- the same persistent location
  // music tracks use, so images survive app updates. The serve route uses
  // this same store, so reads and writes stay consistent.
  const UPLOAD_DIR = process.env.BYH_DATA_DIR
    ? path.join(process.env.BYH_DATA_DIR, 'uploads', cfg.subdir)
    : path.join(process.cwd(), 'public', 'uploads', cfg.subdir);

  function ensureDir() {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  }

  return {
    kind: 'fs',
    blobKind: kind,

    async put({ tmpPath, originalName }) {
      ensureDir();
      // Unique filename to avoid conflicts (timestamp prefix), identical to
      // the original upload route.
      const timestamp = Date.now();
      const base = path.basename(originalName || kind);
      const filename = `${timestamp}_${base}`;
      const finalPath = path.join(UPLOAD_DIR, filename);
      // Move the temp file into place. A plain rename fails with EXDEV when the
      // OS temp dir and the uploads dir live on different filesystems (e.g. a
      // dev container where the workspace is a separate bind mount), so fall
      // back to copy + unlink in that case.
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(tmpPath, finalPath);
        fs.unlinkSync(tmpPath);
      }
      const size = fs.statSync(finalPath).size;
      return {
        key: filename,
        filename,
        url: this.getUrl(filename),
        size,
      };
    },

    getUrl(key) {
      return `${cfg.serveBase}/${encodeURIComponent(key)}`;
    },

    async delete(key) {
      const safe = path.basename(key || '');
      if (!safe) return;
      const p = path.join(UPLOAD_DIR, safe);
      if (!p.startsWith(UPLOAD_DIR + path.sep)) return;
      try { await fs.promises.unlink(p); } catch { /* best effort */ }
    },

    openForServe(key) {
      const safe = path.basename(key || '');
      if (!safe || safe !== key) return null;
      const p = path.join(UPLOAD_DIR, safe);
      if (!p.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(p)) return null;
      const stat = fs.statSync(p);
      return { path: p, size: stat.size };
    },
  };
}

const _stores = new Map();

/**
 * Resolve the blob store for the given kind ('audio' | 'image') and the
 * current deployment profile. Memoized per kind. Defaults to 'audio' so the
 * existing audio call sites (getBlobStore()) are unchanged.
 *
 * The supabase implementation is dynamically required so the local build
 * never imports @supabase/* code.
 */
export function getBlobStore(kind = 'audio') {
  if (_stores.has(kind)) return _stores.get(kind);
  let store;
  if (caps.audioStore === 'supabase') {
    // eslint-disable-next-line global-require
    const { createSupabaseBlobStore } = require('./supabaseBlobStore');
    store = createSupabaseBlobStore(kind);
  } else {
    store = createFsBlobStore(kind);
  }
  _stores.set(kind, store);
  return store;
}

/**
 * Given a value stored in inventory.image, return the local fs key (filename)
 * if it points at a locally-uploaded image we own, else null. Used to clean up
 * the backing file when an item is deleted or its image is replaced. External
 * URLs (https://…) and empty values return null.
 */
export function localImageKey(imageValue) {
  if (!imageValue || typeof imageValue !== 'string') return null;
  const marker = `${KIND_CONFIG.image.serveBase}/`;
  const idx = imageValue.indexOf(marker);
  if (idx === -1) return null;
  const tail = imageValue.slice(idx + marker.length);
  if (!tail) return null;
  // Strip any query/hash and decode the single path segment.
  const seg = tail.split(/[?#/]/)[0];
  try {
    return decodeURIComponent(seg) || null;
  } catch {
    return seg || null;
  }
}
