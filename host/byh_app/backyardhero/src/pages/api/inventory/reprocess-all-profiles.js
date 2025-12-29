import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { thresholdRatio, mergeThresholdMs, reprocessAll, overrideDuration, detectionMethod, floorPercent } = req.body;

    // Validate detection method
    const method = detectionMethod || 'max_amplitude';
    if (!['max_amplitude', 'noise_floor'].includes(method)) {
      return res.status(400).json({ 
        error: 'Detection method must be either "max_amplitude" or "noise_floor".' 
      });
    }

    // Validate threshold ratio if using max_amplitude method
    if (method === 'max_amplitude' && thresholdRatio !== undefined && (thresholdRatio < 0 || thresholdRatio > 1)) {
      return res.status(400).json({ 
        error: 'Threshold ratio must be between 0 and 1.' 
      });
    }

    // Validate floor percent if using noise_floor method
    if (method === 'noise_floor' && floorPercent !== undefined && (isNaN(floorPercent) || floorPercent < 0)) {
      return res.status(400).json({ 
        error: 'Floor percent must be a non-negative number.' 
      });
    }

    // Validate merge threshold if provided
    if (mergeThresholdMs !== undefined && (mergeThresholdMs < 0)) {
      return res.status(400).json({ 
        error: 'Merge threshold must be a non-negative number.' 
      });
    }

    // Determine script path based on environment
    let scriptPath;
    const cwd = process.cwd();
    
    // Try possible paths in order of likelihood
    const possiblePaths = [
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

    // Build the command
    let command = `${pythonPath} "${scriptPath}"`;
    
    if (reprocessAll) {
      command += ' --reprocess-all';
    }
    
    // Add detection method
    command += ` --detection-method ${method}`;
    
    if (method === 'max_amplitude' && thresholdRatio !== undefined) {
      command += ` --threshold-ratio ${thresholdRatio}`;
    }
    
    if (method === 'noise_floor' && floorPercent !== undefined) {
      command += ` --floor-percent ${floorPercent}`;
    }
    
    if (mergeThresholdMs !== undefined) {
      command += ` --merge-threshold-ms ${mergeThresholdMs}`;
    }
    
    if (overrideDuration === true) {
      command += ` --override-duration`;
    }

    console.log(`Executing command: ${command}`);
    // Execute the script
    // Note: This runs asynchronously, so we'll return immediately
    // The script will process in the background
    execAsync(command, {
      cwd: path.dirname(scriptPath),
      timeout: 600000, // 10 minute timeout for batch processing
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
    }).then(({ stdout, stderr }) => {
      console.log('Batch reprocess profiles completed');
      if (stdout) console.log('stdout:', stdout);
      if (stderr) console.error('stderr:', stderr);
    }).catch((error) => {
      console.error('Error batch reprocessing profiles:', error);
      if (error.stdout) console.error('stdout:', error.stdout);
      if (error.stderr) console.error('stderr:', error.stderr);
    });

    // Return immediately - processing happens in background
    return res.status(202).json({ 
      message: 'Batch reprocessing started. This may take several minutes.',
      reprocessAll: reprocessAll || false,
      thresholdRatio: thresholdRatio || 0.70,
      overrideDuration: overrideDuration || false
    });
  } catch (error) {
    console.error('Error starting batch reprocess:', error);
    return res.status(500).json({ error: 'Failed to start batch reprocessing.' });
  }
}

