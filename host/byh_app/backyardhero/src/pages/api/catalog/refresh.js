import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Get progress status
    try {
      const progressPath = '/data/catalog_crawl_progress.json';
      if (fs.existsSync(progressPath)) {
        const progressData = fs.readFileSync(progressPath, 'utf-8');
        const progress = JSON.parse(progressData);
        return res.status(200).json(progress);
      } else {
        return res.status(200).json({
          status: 'idle',
          current: 0,
          total: 0,
          message: 'No crawl in progress',
          timestamp: Math.floor(Date.now() / 1000)
        });
      }
    } catch (error) {
      console.error('Error reading progress:', error);
      return res.status(500).json({ error: 'Failed to read progress' });
    }
  } else if (req.method === 'POST') {
    // Start catalog crawl
    try {
      // Check if a crawl is already running
      const progressPath = '/data/catalog_crawl_progress.json';
      if (fs.existsSync(progressPath)) {
        const progressData = fs.readFileSync(progressPath, 'utf-8');
        const progress = JSON.parse(progressData);
        if (progress.status === 'running') {
          return res.status(409).json({ 
            error: 'Catalog crawl is already in progress',
            progress: progress
          });
        }
      }

      // Find the script path (crawl_catalog.py in pythings/inv_crawl directory)
      let scriptPath = path.join(process.cwd(), '../../pythings/inv_crawl/crawl_catalog.py');
      
      // Try alternative paths
      const possiblePaths = [
        scriptPath,
        path.join(process.cwd(), '../../../pythings/inv_crawl/crawl_catalog.py'),
        path.join(process.cwd(), '../../../../pythings/inv_crawl/crawl_catalog.py'),
        '/app/pythings/inv_crawl/crawl_catalog.py',
        path.join(__dirname, '../../../../pythings/inv_crawl/crawl_catalog.py'),
        path.join(process.cwd(), 'pythings/inv_crawl/crawl_catalog.py')
      ];

      let foundPath = null;
      for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
          foundPath = testPath;
          break;
        }
      }

      if (!foundPath) {
        console.error('Script not found. Tried paths:', possiblePaths);
        return res.status(500).json({ 
          error: 'Catalog gather script not found. Please check installation.' 
        });
      }

      // Get Python path
      const pythonPath = process.env.PYTHON_PATH || 'python3';

      // Execute the script in the background
      const command = `${pythonPath} "${foundPath}"`;
      
      console.log(`Starting catalog crawl: ${command}`);

      // Execute asynchronously (don't wait for completion)
      execAsync(command).catch(err => {
        console.error('Error executing catalog crawl:', err);
      });

      // Return immediately with initial status
      return res.status(202).json({ 
        message: 'Catalog crawl started',
        status: 'running'
      });
    } catch (error) {
      console.error('Error starting catalog crawl:', error);
      return res.status(500).json({ error: 'Failed to start catalog crawl' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}

