import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

import { getRepo } from '@/data';
import { caps } from '@/util/profile';

const execFileAsync = promisify(execFile);

// Estimate an aerial shell's lift_delay (lift -> break) from its YouTube video's
// audio, using pythings/fp_gen/lift_break_timer.py. Unlike reprocess-profile,
// this runs synchronously and only *proposes* a value: nothing is written. The
// UI shows the result and saves it through the normal PATCH /api/inventory/[id].
//
// POST body (all optional):
//   startSec     first-lift time; defaults to the item's youtube_link_start_sec
//   expected     seed delay in seconds, if the automatic one goes wrong
//   sensitivity  >1 finds quieter sounds, <1 is stricter (default 1)

const SCRIPT = path.join('fp_gen', 'lift_break_timer.py');

function findScript() {
  const cwd = process.cwd();
  const candidates = [
    ...(process.env.BYH_PYTHINGS_DIR ? [path.join(process.env.BYH_PYTHINGS_DIR, SCRIPT)] : []),
    path.join('/app/pythings', SCRIPT),
    path.resolve(cwd, '../../pythings', SCRIPT),
    path.resolve(cwd, '../../../pythings', SCRIPT),
    path.resolve(cwd, '../../../../pythings', SCRIPT),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function findPython(scriptPath) {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  // Local dev: prefer fp_gen's own venv (install.sh), which has librosa etc.
  const venvPython = path.join(path.dirname(scriptPath), 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}

const optionalNumber = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  if (caps.profile === 'cloud') {
    return res.status(501).json({ error: 'Lift delay estimation is only available in the local app.' });
  }

  const itemId = Number(req.query.id);
  if (!Number.isInteger(itemId) || itemId < 0) {
    return res.status(400).json({ error: 'Item ID must be a non-negative integer.' });
  }

  let item;
  try {
    const repo = await getRepo(req);
    item = await repo.inventory.getById(itemId);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to load item.' });
  }
  if (!item) return res.status(404).json({ error: 'Inventory item not found.' });
  if (item.type !== 'AERIAL_SHELL') {
    return res.status(400).json({ error: 'Lift delay estimation is only for aerial shells.' });
  }
  const url = String(item.youtube_link || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'This item has no YouTube link.' });
  }

  const startSec = optionalNumber(req.body?.startSec) ?? optionalNumber(item.youtube_link_start_sec);
  const expected = optionalNumber(req.body?.expected);
  const sensitivity = optionalNumber(req.body?.sensitivity);
  if (startSec === undefined || !Number.isFinite(startSec) || startSec < 0) {
    return res.status(400).json({ error: 'Set a YouTube start time at the first lift.' });
  }
  if (expected !== undefined && !(Number.isFinite(expected) && expected > 0 && expected < 20)) {
    return res.status(400).json({ error: 'Expected delay must be between 0 and 20 seconds.' });
  }
  if (sensitivity !== undefined && !(Number.isFinite(sensitivity) && sensitivity > 0 && sensitivity <= 10)) {
    return res.status(400).json({ error: 'Sensitivity must be between 0 and 10.' });
  }

  const scriptPath = findScript();
  if (!scriptPath) {
    return res.status(500).json({ error: 'lift_break_timer.py not found. Please check the installation.' });
  }

  // argv array, no shell. The URL goes after `--` so it can never be read as a flag.
  const args = [scriptPath, '--json', '--start', String(startSec)];
  if (expected !== undefined) args.push('--expected', String(expected));
  if (sensitivity !== undefined) args.push('--sensitivity', String(sensitivity));
  args.push('--', url);

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(findPython(scriptPath), args, {
      cwd: path.dirname(scriptPath),
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    // The script exits 1 with a JSON {ok:false,error} when it finds nothing.
    stdout = err.stdout || '';
    if (!stdout.trim()) {
      console.error('estimate-lift-delay failed:', err.stderr || err.message);
      const timedOut = err.killed || err.signal === 'SIGTERM';
      return res.status(500).json({
        error: timedOut ? 'Analysis timed out.' : 'Analysis failed to run. Is fp_gen installed?',
      });
    }
  }

  let result;
  try {
    result = JSON.parse(stdout.trim().split('\n').pop());
  } catch {
    console.error('estimate-lift-delay: unparseable output:', stdout);
    return res.status(500).json({ error: 'Analysis returned unexpected output.' });
  }
  if (!result.ok) return res.status(422).json(result);
  return res.status(200).json({ ...result, current: item.lift_delay ?? null });
}
