import fs from 'fs/promises';

export default async function handler(req, res) {
  try {
    const result = {
      fw_cursor: null,
      fw_firing: null,
    };

    // Check for /tmp/fw_cursor
    try {
      const fwCursorExists = await fs.stat('/tmp/fw_cursor');
      if (fwCursorExists.isFile()) {
        const cursorContent = await fs.readFile('/tmp/fw_cursor', 'utf8');
        result.fw_cursor = parseFloat(cursorContent.trim());
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error reading /tmp/fw_cursor:', err);
        result.fw_cursor = -1;
      }else{
        console.error(err);
        result.fw_cursor = -2;
      }
    }

    // Check for /tmp/fw_firing
    try {
      const fwFiringExists = await fs.stat('/tmp/fw_firing');
      if (fwFiringExists.isFile()) {
        const firingContent = await fs.readFile('/tmp/fw_firing', 'utf8');
        result.fw_firing = JSON.parse(firingContent.trim());
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error reading /tmp/fw_firing:', err);
        result.fw_firing = {err};
      }else{
        console.error(err)
        result.fw_firing = {err};
      }
    }

    // Respond with the result
    res.status(200).json(result);
  } catch (error) {
    console.error('Unexpected error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}