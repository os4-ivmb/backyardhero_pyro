import { promises as fs } from 'fs';

const configPath = '/config/systemcfg.json';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const fileContent = await fs.readFile(configPath, 'utf-8');
      const systemConfig = JSON.parse(fileContent);
      res.status(200).json(systemConfig);
    } catch (error) {
      console.error('Error reading system configuration:', error);
      res.status(500).json({ error: 'Failed to read system configuration' });
    }
  } else if (req.method === 'POST') {
    try {
      const newConfig = req.body;
      await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
      res.status(200).json({ message: 'System configuration updated successfully' });
    } catch (error) {
      console.error('Error writing system configuration:', error);
      res.status(500).json({ error: 'Failed to update system configuration' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
