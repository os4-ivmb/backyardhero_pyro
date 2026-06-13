import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'public', 'uploads', 'audio');

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
    return res.status(400).json({ error: 'Invalid audio filename.' });
  }

  const filePath = path.join(AUDIO_DIR, filename);
  if (!filePath.startsWith(AUDIO_DIR + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found.' });
  }

  const stat = fs.statSync(filePath);
  const contentType = contentTypeFor(filename);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', stat.size);
    return res.status(200).end();
  }

  const range = req.headers.range;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end >= stat.size ||
      start > end
    ) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', stat.size);
  return fs.createReadStream(filePath).pipe(res);
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}
