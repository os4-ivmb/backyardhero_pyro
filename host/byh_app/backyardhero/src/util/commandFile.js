import fs from 'fs';
import path from 'path';

/**
 * Write one daemon command file atomically: write a dotfile temp next to it,
 * then rename into place. The daemon reacts to directory changes as they
 * happen (not only on its 50ms poll), so it must never see a half-written
 * file; it skips dotfiles and *.tmp, and rename(2) within a directory is
 * atomic.
 */
export function writeCommandFile(filePath, payload) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmpPath, typeof payload === 'string' ? payload : JSON.stringify(payload));
  fs.renameSync(tmpPath, filePath);
}
