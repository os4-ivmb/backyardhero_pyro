import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export default async function handler(req, res) {
  try {
    const { id } = req.query;

    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    if (!id) {
      return res.status(400).json({ error: 'Item ID is required.' });
    }

    // W4b: `id` flows into a child process. It used to be interpolated
    // into a shell string passed to exec(), so `1; rm -rf ...` executed.
    // Integer-validate and pass argv to execFile (no shell) below.
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId < 0) {
      return res.status(400).json({ error: 'Item ID must be a non-negative integer.' });
    }

    // Safely get parameters from body
    let thresholdRatio;
    let mergeThresholdMs;
    let overrideDuration;
    let detectionMethod;
    let floorPercent;
    try {
      thresholdRatio = req.body?.thresholdRatio;
      mergeThresholdMs = req.body?.mergeThresholdMs;
      overrideDuration = req.body?.overrideDuration;
      detectionMethod = req.body?.detectionMethod || 'max_amplitude';
      floorPercent = req.body?.floorPercent;
    } catch (err) {
      console.error('Error parsing request body:', err);
      return res.status(400).json({ error: 'Invalid request body.' });
    }

    // Validate detection method
    if (detectionMethod && !['max_amplitude', 'noise_floor'].includes(detectionMethod)) {
      return res.status(400).json({ 
        error: 'Detection method must be either "max_amplitude" or "noise_floor".' 
      });
    }

    // Validate threshold ratio if using max_amplitude method
    if (detectionMethod === 'max_amplitude' && thresholdRatio !== undefined && (isNaN(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1)) {
      return res.status(400).json({ 
        error: 'Threshold ratio must be a number between 0 and 1.' 
      });
    }

    // Validate floor percent if using noise_floor method
    if (detectionMethod === 'noise_floor' && floorPercent !== undefined && (isNaN(floorPercent) || floorPercent < 0)) {
      return res.status(400).json({ 
        error: 'Floor percent must be a non-negative number.' 
      });
    }

    // Validate merge threshold if provided
    if (mergeThresholdMs !== undefined && (isNaN(mergeThresholdMs) || mergeThresholdMs < 0)) {
      return res.status(400).json({ 
        error: 'Merge threshold must be a non-negative number.' 
      });
    }

    // Determine script path based on environment
    let scriptPath;
    const cwd = process.cwd();
    
    // Try possible paths in order of likelihood
    const possiblePaths = [
      // Desktop bundle: the supervisor exports BYH_PYTHINGS_DIR.
      ...(process.env.BYH_PYTHINGS_DIR
        ? [path.join(process.env.BYH_PYTHINGS_DIR, 'fp_gen', 'process_firing_profiles.py')]
        : []),
      // Production/Docker path (most common)
      '/app/pythings/fp_gen/process_firing_profiles.py',
      // Local development paths
      path.resolve(cwd, '../../pythings/fp_gen/process_firing_profiles.py'),
      path.resolve(cwd, '../../../pythings/fp_gen/process_firing_profiles.py'),
      path.resolve(cwd, '../../../../pythings/fp_gen/process_firing_profiles.py'),
      // Absolute path fallback for local dev
      '/Users/alex/proj/firework/backyardhero/host/pythings/fp_gen/process_firing_profiles.py',
    ];
    
    scriptPath = possiblePaths.find(p => {
      try {
        const resolved = path.resolve(p);
        return fs.existsSync(resolved);
      } catch (err) {
        console.error(`Error checking path ${p}:`, err);
        return false;
      }
    });

    if (!scriptPath) {
      console.error('Could not find script. Tried paths:', possiblePaths);
      console.error('Current working directory:', cwd);
      return res.status(500).json({ 
        error: 'Firing profile processor script not found. Please check the installation.',
        debug: process.env.NODE_ENV === 'development' ? {
          cwd: cwd,
          triedPaths: possiblePaths.map(p => {
            try {
              return path.resolve(p);
            } catch {
              return p;
            }
          })
        } : undefined
      });
    }
    
    // Resolve to absolute path
    scriptPath = path.resolve(scriptPath);

    // Resolve to absolute path
    scriptPath = path.resolve(scriptPath);

    // Verify script exists
    if (!fs.existsSync(scriptPath)) {
      console.error(`Script not found at: ${scriptPath}`);
      console.error(`Current working directory: ${process.cwd()}`);
      return res.status(500).json({ 
        error: `Firing profile processor script not found at: ${scriptPath}. Please check the installation.` 
      });
    }

    // Get Python path - try python3 first, then python
    const pythonPath = process.env.PYTHON_PATH || 'python3';

    // Build an argv array (no shell) so nothing here can be interpreted
    // as shell syntax. Numeric args are coerced to strings.
    const args = [
      scriptPath,
      '--item-id', String(itemId),
      '--detection-method', detectionMethod || 'max_amplitude',
    ];
    if (detectionMethod === 'max_amplitude' && thresholdRatio !== undefined) {
      args.push('--threshold-ratio', String(thresholdRatio));
    }
    if (detectionMethod === 'noise_floor' && floorPercent !== undefined) {
      args.push('--floor-percent', String(floorPercent));
    }
    if (mergeThresholdMs !== undefined) {
      args.push('--merge-threshold-ms', String(mergeThresholdMs));
    }
    if (overrideDuration === true) {
      args.push('--override-duration');
    }

    console.log(`Executing: ${pythonPath} ${args.join(' ')}`);
    console.log(`Working directory: ${path.dirname(scriptPath)}`);

    // Execute the script via execFile (no shell). Runs asynchronously;
    // we return immediately and let it process in the background.
    execFileAsync(pythonPath, args, {
      cwd: path.dirname(scriptPath),
      timeout: 300000, // 5 minute timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
    }).then(({ stdout, stderr }) => {
      console.log(`Reprocess profile for item ${itemId} completed`);
      if (stdout) console.log('stdout:', stdout);
      if (stderr) console.error('stderr:', stderr);
    }).catch((error) => {
      console.error(`Error reprocessing profile for item ${itemId}:`, error);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
      if (error.code) console.error('Error code:', error.code);
    });

    // Return immediately - processing happens in background
    return res.status(202).json({ 
      message: 'Reprocessing started. This may take a few minutes.',
      itemId: itemId
    });
  } catch (error) {
    console.error('Error starting reprocess:', error);
    console.error('Error stack:', error.stack);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    return res.status(500).json({ 
      error: 'Failed to start reprocessing.',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : undefined
    });
  }
}

