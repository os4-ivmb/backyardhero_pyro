import formidable from 'formidable';
import os from 'os';
import { getBlobStore } from '@/data/blobStore';
import { resolveCtx } from '@/data/context';

// Disable the default body parser to handle file uploads (multipart/form-data).
export const config = {
  api: {
    bodyParser: false,
  },
};

// Inventory item images are small; cap well under the audio limit.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

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
    // store. The fs store moves it into uploads/images (local); the supabase
    // store uploads it to Storage (cloud). The route stays backend-agnostic.
    const uploadDir = os.tmpdir();
    const store = getBlobStore('image');

    const form = formidable({
      uploadDir,
      keepExtensions: true,
      maxFileSize: MAX_IMAGE_BYTES,
      multiples: false,
      filter: ({ mimetype }) => Boolean(mimetype && mimetype.startsWith('image/')),
    });

    const parseForm = () =>
      new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

    let parsed;
    try {
      parsed = await parseForm();
    } catch (parseError) {
      console.error('Error parsing image upload:', parseError);
      return res.status(400).json({ error: 'Failed to parse uploaded image.' });
    }

    const imageField = parsed.files.image || parsed.files.file;
    if (!imageField) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    // formidable v3 may hand back an array or a single file object.
    const file = Array.isArray(imageField) ? imageField[0] : imageField;
    if (!file || !file.filepath) {
      return res.status(400).json({ error: 'No valid image file provided.' });
    }

    const originalName = file.originalFilename || 'image';

    const stored = await store.put({
      tmpPath: file.filepath,
      originalName,
      mimetype: file.mimetype,
      userId: ctx.userId,
    });

    return res.status(200).json({
      url: stored.url,
      key: stored.key,
      filename: stored.filename || stored.key,
      originalName,
      size: stored.size ?? file.size,
      mimetype: file.mimetype,
    });
  } catch (error) {
    console.error('Image upload error:', error);
    return res.status(500).json({ error: 'Failed to upload image.' });
  }
}
