import Database from 'better-sqlite3';
import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DB_PATH, db } from '@/util/sqldb';

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
    await db.backup(exportPath);
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
  const backupPath = `${DB_PATH}.backup-${timestampForFilename()}`;

  try {
    const { files } = await parseUpload(req);
    const file = firstFile(files.database);
    if (!file?.filepath) {
      return res.status(400).json({ error: 'No database file uploaded.' });
    }
    uploadedPath = file.filepath;

    validateBackyardHeroDb(uploadedPath);

    await db.backup(backupPath);
    db.close();
    await fs.promises.copyFile(uploadedPath, DB_PATH);

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
    res.status(500).json({
      error: error?.message || 'Failed to import database.',
    });
  } finally {
    cleanupFile(uploadedPath);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleExport(req, res);
  }

  if (req.method === 'POST') {
    return handleImport(req, res);
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
