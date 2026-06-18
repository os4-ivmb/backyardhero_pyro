import formidable from 'formidable';
import os from 'os';
import { getBlobStore } from '@/data/blobStore';
import { resolveCtx } from '@/data/context';

// Disable the default body parser to handle file uploads
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  console.log('Upload request received');
  console.log('Content-Type:', req.headers['content-type']);

  // Resolve the persistence context (cloud: the signed-in user; local:
  // 'local'). The userId becomes the Storage path prefix in the cloud store.
  let ctx;
  try {
    ctx = await resolveCtx(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  try {
    // Parse into the OS temp dir first, then hand the temp file to the blob
    // store. The fs store moves it into public/uploads/audio (local); the
    // supabase store uploads it to Storage (cloud). Either way the route is
    // backend-agnostic (Cloud Builder §3.3).
    const uploadDir = os.tmpdir();
    const store = getBlobStore();

    const form = formidable({
      uploadDir: uploadDir,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024, // 50MB limit
      multiples: false,
      filter: function ({ name, originalFilename, mimetype }) {
        console.log('Filtering file:', { name, originalFilename, mimetype });
        // Only allow audio files
        return mimetype && mimetype.includes('audio');
      },
    });

    // Use promise-based parsing for better error handling
    const parseForm = () => {
      return new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          console.log('Form parse callback called');
          console.log('Error:', err);
          console.log('Fields:', fields);
          console.log('Files:', files);
          if (err) {
            reject(err);
          } else {
            resolve({ fields, files });
          }
        });
      });
    };

    try {
      const { fields, files } = await parseForm();
      
      console.log('Form parsed successfully');
      console.log('Files received:', files);

      const audioFile = files.audio;
      if (!audioFile) {
        console.error('No audio file found in request');
        return res.status(400).json({ error: 'No audio file provided.' });
      }

      // In formidable v3, files can be an array or a single file object
      const file = Array.isArray(audioFile) ? audioFile[0] : audioFile;
      
      console.log('Audio file details:', {
        filepath: file.filepath,
        originalFilename: file.originalFilename,
        size: file.size,
        mimetype: file.mimetype
      });

      // Check if filepath exists
      if (!file.filepath) {
        console.error('Audio file has no filepath');
        return res.status(500).json({ error: 'File upload failed - no filepath.' });
      }

      const originalName = file.originalFilename || 'audio';

      // Hand off to the blob store (fs move locally / Storage upload in cloud).
      const stored = await store.put({
        tmpPath: file.filepath,
        originalName,
        mimetype: file.mimetype,
        userId: ctx.userId,
      });

      res.status(200).json({
        url: stored.url,
        key: stored.key,
        filename: stored.filename || stored.key,
        originalName,
        size: stored.size ?? file.size,
        mimetype: file.mimetype,
      });
    } catch (parseError) {
      console.error('Error parsing form:', parseError);
      res.status(500).json({ error: 'Failed to parse uploaded file.' });
    }
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload audio file.' });
  }
} 