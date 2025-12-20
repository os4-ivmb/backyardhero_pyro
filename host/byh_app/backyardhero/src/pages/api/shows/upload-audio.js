import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

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

  try {
    // Ensure upload directory exists first
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'audio');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log('Created upload directory:', uploadDir);
    }

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

      // Generate a unique filename to avoid conflicts
      const timestamp = Date.now();
      const originalName = file.originalFilename || 'audio';
      const extension = path.extname(originalName);
      const newFilename = `${timestamp}_${originalName}`;
      const newPath = path.join(uploadDir, newFilename);

      console.log('Moving file from', file.filepath, 'to', newPath);

      // Move the file to the final location
      fs.renameSync(file.filepath, newPath);
      console.log('File moved successfully');

      // Return the URL for the uploaded file
      const url = `/uploads/audio/${newFilename}`;
      
      res.status(200).json({ 
        url,
        filename: newFilename,
        originalName: originalName,
        size: file.size,
        mimetype: file.mimetype
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