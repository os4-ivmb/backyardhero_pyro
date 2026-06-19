// Supabase Storage blob store for show audio (Cloud Builder plan §3.3).
//
// Object key layout: audio/<userId>/<uuid>.<ext>. Uploads use the service
// client (the upload route has already authenticated the user and supplies
// their id as the path prefix); reads are handed out as signed URLs. Storage
// RLS scopes access by the <userId> path segment.
//
// Durability note: signed URLs expire. The stored Show.audio_file keeps the
// object KEY, and getUrl(key) re-signs on demand, so a long-lived show can
// always mint a fresh playback URL. The upload response also includes a
// ready-to-use signed URL for immediate playback.

import { randomUUID } from 'crypto';
import path from 'path';
import { createReadStream } from 'fs';
import { createServiceSupabase } from '@/util/supabase/server';

const SIGNED_URL_TTL_S = 60 * 60 * 24 * 7; // 7 days; re-signed via getUrl()

// Per-kind bucket + object-key prefix. Image support mirrors audio so the
// cloud profile can store inventory images alongside tracks; both are served
// via signed URLs that getUrl() re-signs on demand.
const KIND = {
  audio: {
    bucket: process.env.BYH_AUDIO_BUCKET || 'show-audio',
    prefix: 'audio',
    defaultExt: '.mp3',
  },
  image: {
    bucket: process.env.BYH_IMAGE_BUCKET || 'inventory-images',
    prefix: 'images',
    defaultExt: '.png',
  },
};

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

export function createSupabaseBlobStore(kind = 'audio') {
  const sb = createServiceSupabase();
  const cfg = KIND[kind] || KIND.audio;
  const BUCKET = cfg.bucket;

  return {
    kind: 'supabase',
    blobKind: kind,

    async put({ tmpPath, originalName, mimetype, userId }) {
      if (!userId) throw new Error('Supabase blob store requires a userId.');
      const ext = path.extname(originalName || '') || cfg.defaultExt;
      const key = `${cfg.prefix}/${userId}/${randomUUID()}${ext}`;

      const body = createReadStream(tmpPath);
      const { error } = await sb.storage.from(BUCKET).upload(key, body, {
        contentType: mimetype || contentTypeFor(originalName || ''),
        upsert: false,
        duplex: 'half',
      });
      if (error) throw new Error(error.message || 'Failed to upload audio.');

      const url = await this.getUrl(key);
      return { key, filename: path.basename(key), url };
    },

    async getUrl(key) {
      const { data, error } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(key, SIGNED_URL_TTL_S);
      if (error) throw new Error(error.message || 'Failed to sign audio URL.');
      return data.signedUrl;
    },

    async delete(key) {
      if (!key) return;
      try { await sb.storage.from(BUCKET).remove([key]); } catch { /* best effort */ }
    },

    // Cloud serves via signed URLs, never a byte stream from this app.
    openForServe() {
      return null;
    },
  };
}
