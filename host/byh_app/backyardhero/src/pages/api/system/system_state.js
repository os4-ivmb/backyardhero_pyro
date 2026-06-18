import fs from 'fs/promises';
import { ensureHardware } from '@/util/apiGuards';
import { CURSOR_FILE, FIRING_FILE } from '@/util/paths';

export default async function handler(req, res) {
  if (!ensureHardware(res)) return;
  try {
    const result = {
      fw_cursor: null,
      fw_firing: null,
    };

    // Check for the firmware-cursor marker
    try {
      const fwCursorExists = await fs.stat(CURSOR_FILE);
      if (fwCursorExists.isFile()) {
        const cursorContent = await fs.readFile(CURSOR_FILE, 'utf8');
        result.fw_cursor = parseFloat(cursorContent.trim());
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error reading fw_cursor:', err);
        result.fw_cursor = -1;
      }else{
        console.error(err);
        result.fw_cursor = -2;
      }
    }

    // Check for the firmware-firing marker
    try {
      const fwFiringExists = await fs.stat(FIRING_FILE);
      if (fwFiringExists.isFile()) {
        const firingContent = await fs.readFile(FIRING_FILE, 'utf8');
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