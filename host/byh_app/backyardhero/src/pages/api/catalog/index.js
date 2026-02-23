import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  if (req.method === 'GET') {
    try {
      // Path to catalog.json - adjust based on your setup
      // In Docker, it's mounted at /data/catalog.json
      // For development, it's at the project root data/catalog.json
      const catalogPath = process.env.CATALOG_PATH;
      
      // Try multiple possible paths (prioritize /data/catalog.json)
      let catalogData = null;
      const possiblePaths = [
        '/data/catalog.json', // Docker mount location (host/data mapped to /data)
        catalogPath, // If CATALOG_PATH env var is set
        path.join(process.cwd(), '../../../../data/catalog.json'), // From host/byh_app/backyardhero to root data/
        path.join(process.cwd(), '../../../data/catalog.json'), // Alternative path
        path.join(process.cwd(), '../../data/catalog.json'), // Another alternative
        path.join(process.cwd(), 'data/catalog.json') // Local data folder
      ].filter(Boolean); // Remove undefined values
      
      for (const filePath of possiblePaths) {
        try {
          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            catalogData = JSON.parse(fileContent);
            break;
          }
        } catch (err) {
          // Try next path
          continue;
        }
      }
      
      if (!catalogData) {
        return res.status(404).json({ error: 'Catalog file not found' });
      }
      
      return res.status(200).json(catalogData);
    } catch (error) {
      console.error('Error reading catalog:', error);
      return res.status(500).json({ error: 'Failed to read catalog file' });
    }
  }

  res.setHeader('Allow', ['GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}

