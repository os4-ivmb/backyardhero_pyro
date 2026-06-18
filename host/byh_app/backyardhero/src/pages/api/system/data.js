import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DB_PATH, getDb, closeDb } from '@/util/sqldb';
import { ensureLocalDb } from '@/util/apiGuards';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_IMPORT_SIZE = 200 * 1024 * 1024;
const REQUIRED_TABLES = new Set(['Show', 'inventory', 'Receivers', 'racks']);

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseUpload(req) {
  const form = formidable({
    uploadDir: os.tmpdir(),
    keepExtensions: true,
    maxFileSize: MAX_IMPORT_SIZE,
    multiples: false,
    filter: ({ name }) => name === 'database',
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function firstFile(fileOrFiles) {
  if (!fileOrFiles) return null;
  return Array.isArray(fileOrFiles) ? fileOrFiles[0] : fileOrFiles;
}

function cleanupFile(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

function validateBackyardHeroDb(filePath) {
  // Lazy-require the native addon so it's never loaded in the cloud build
  // (this whole route is gated on ensureLocalDb anyway).
  const Database = require('better-sqlite3');
  let importedDb;
  try {
    importedDb = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = importedDb.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }

    const tables = importedDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    if (!tables.some((name) => REQUIRED_TABLES.has(name))) {
      throw new Error('Uploaded file does not look like a Backyard Hero database.');
    }
  } finally {
    if (importedDb) importedDb.close();
  }
}

async function handleExport(req, res) {
  const exportPath = path.join(
    os.tmpdir(),
    `backyardhero-export-${process.pid}-${Date.now()}.db`,
  );

  try {
    await getDb().backup(exportPath);
    const stat = await fs.promises.stat(exportPath);
    const filename = `backyardhero-${timestampForFilename()}.db`;

    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(exportPath);
    stream.on('close', () => cleanupFile(exportPath));
    stream.on('error', (error) => {
      cleanupFile(exportPath);
      console.error('Failed to stream database export:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream database export.' });
      } else {
        res.destroy(error);
      }
    });
    stream.pipe(res);
  } catch (error) {
    cleanupFile(exportPath);
    console.error('Failed to export database:', error);
    res.status(500).json({ error: 'Failed to export database.' });
  }
}

async function handleImport(req, res) {
  let uploadedPath = null;
  let stagedPath = null;
  const backupPath = `${DB_PATH}.backup-${timestampForFilename()}`;
  // W4b: track whether we've closed the live connection / swapped the
  // file so the catch block can restore from backup if anything fails
  // mid-swap, instead of leaving a half-overwritten live DB behind.
  let dbClosed = false;
  let swapStarted = false;
  let swapCompleted = false;

  try {
    const { files } = await parseUpload(req);
    const file = firstFile(files.database);
    if (!file?.filepath) {
      return res.status(400).json({ error: 'No database file uploaded.' });
    }
    uploadedPath = file.filepath;

    validateBackyardHeroDb(uploadedPath);

    // Back up the current DB first so we always have a restore point.
    await getDb().backup(backupPath);

    // Stage the import as a sibling temp file on the SAME filesystem as
    // the live DB so the final swap can be an atomic rename(2). Validate
    // the staged copy too (defense against a copy that silently
    // truncated).
    stagedPath = `${DB_PATH}.import-${process.pid}-${Date.now()}.tmp`;
    await fs.promises.copyFile(uploadedPath, stagedPath);
    validateBackyardHeroDb(stagedPath);

    // Close the live connection only once we're about to swap. Anything
    // that failed above left the live DB and its open connection intact.
    // closeDb() also drops the memoized handle so a failed-swap restore
    // path can reopen cleanly without a process restart.
    closeDb();
    dbClosed = true;
    swapStarted = true;

    // Remove stale WAL/SHM sidecars so the freshly-swapped main DB file
    // isn't reinterpreted through a previous database's write-ahead log.
    for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      try { await fs.promises.unlink(sidecar); } catch { /* may not exist */ }
    }

    // Atomic publish.
    await fs.promises.rename(stagedPath, DB_PATH);
    stagedPath = null;
    swapCompleted = true;

    // Only schedule the restart AFTER a verified, completed swap.
    res.once('finish', () => {
      setTimeout(() => process.exit(0), 500);
    });

    res.status(200).json({
      message: 'Database imported. Backyard Hero is restarting to load it.',
      backupPath,
      restart: true,
    });
  } catch (error) {
    console.error('Failed to import database:', error);

    // If we got far enough to disturb the live DB, restore it from the
    // backup we took above so we never leave the operator with a broken
    // database. (process.exit is only scheduled on the success path, so
    // the restored DB will be picked up without a restart.)
    if (swapStarted && !swapCompleted) {
      try {
        await fs.promises.copyFile(backupPath, DB_PATH);
        for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
          try { await fs.promises.unlink(sidecar); } catch { /* may not exist */ }
        }
        console.error('Import failed mid-swap; restored DB from backup', backupPath);
      } catch (restoreErr) {
        console.error('CRITICAL: failed to restore DB from backup:', restoreErr);
      }
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: error?.message || 'Failed to import database.',
        backupPath: dbClosed ? backupPath : undefined,
      });
    }
  } finally {
    cleanupFile(uploadedPath);
    if (stagedPath) cleanupFile(stagedPath);
  }
}

export default async function handler(req, res) {
  // Whole-database export/import only makes sense against the local SQLite
  // file; the cloud profile uses Supabase Postgres (per-user, RLS).
  if (!ensureLocalDb(res)) return;
  if (req.method === 'GET') {
    return handleExport(req, res);
  }

  if (req.method === 'POST') {
    return handleImport(req, res);
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
