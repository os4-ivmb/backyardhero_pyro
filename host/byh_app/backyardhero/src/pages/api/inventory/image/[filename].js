import fs from 'fs';
import path from 'path';
import { caps } from '@/util/profile';
import { getBlobStore } from '@/data/blobStore';

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', ['GET', 'HEAD']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const rawFilename = Array.isArray(req.query.filename)
    ? req.query.filename.join('/')
    : req.query.filename;
  const filename = path.basename(rawFilename || '');
  if (!filename || filename !== rawFilename) {
    return res.status(400).json({ error: 'Invalid image filename.' });
  }

  // Cloud profile serves images via signed Storage URLs (the client gets the
  // URL straight from the blob store on upload), so this byte-streaming route
  // is local-only. Defense in depth: refuse here when there's no fs store.
  if (caps.audioStore !== 'fs') {
    return res.status(501).json({ error: 'Images are served via signed URLs in this deployment.' });
  }

  const store = getBlobStore('image');
  const opened = store.openForServe(filename);
  if (!opened) {
    return res.status(404).json({ error: 'Image not found.' });
  }

  // Filenames are timestamp-prefixed and never reused, so the bytes are
  // immutable -- cache aggressively.
  res.setHeader('Content-Type', contentTypeFor(filename));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Length', opened.size);

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  return fs.createReadStream(opened.path).pipe(res);
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
