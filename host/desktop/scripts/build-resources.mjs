#!/usr/bin/env node
/**
 * Assembles everything the Electron app ships in `resources/`:
 *
 *   resources/app/      Next.js standalone server (server.js + .next + public
 *                       + minimal node_modules, with better-sqlite3 rebuilt
 *                       for Electron's ABI)
 *   resources/python/   embedded CPython (python-build-standalone) with all
 *                       Python requirements pip-installed into it
 *   resources/pythings/ Python service sources (ws_server, pc_daemon, fp_gen,
 *                       inv_crawl)
 *   resources/bridge/   tcp_serial_bridge + flash_server
 *   resources/config/   default systemcfg.json seed
 *
 * Runs on macOS, Windows, and Linux. Designed to be the single command a CI
 * job (or a developer) invokes before electron-builder. Platform/arch are
 * taken from the host running this script (PyInstaller-style native builds
 * can't cross-compile, so CI uses one runner per target -- see
 * .github/workflows/build-desktop.yml).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, cp, access, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const HOST_DIR = path.resolve(DESKTOP_DIR, '..');
const APP_SRC = path.join(HOST_DIR, 'byh_app', 'backyardhero');
const RES = path.join(DESKTOP_DIR, 'resources');

const isWin = process.platform === 'win32';
const INCLUDE_AUDIO = process.env.BYH_INCLUDE_AUDIO !== '0';

// python-build-standalone release coordinates. Override via env if a newer
// build is needed; the URL can be fully overridden with BYH_PYTHON_URL.
const PY_TAG = process.env.BYH_PYTHON_BUILD_TAG || '20241016';
const PY_VER = process.env.BYH_PYTHON_VERSION || '3.12.7';

const PY_TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

function log(...a) {
  console.log('[build-resources]', ...a);
}

function run(cmd, args, opts = {}) {
  log('$', cmd, args.join(' '));
  // Node (>=18.20 / >=20.12, CVE-2024-27980) refuses to spawn .cmd/.bat
  // shims without shell:true, failing with status=null / EINVAL. On Windows
  // npm.cmd / npx.cmd therefore need a shell; native exes (python.exe, tar)
  // do not. CI paths have no spaces, so the lack of arg-quoting under
  // shell:true is fine here.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts, shell: opts.shell ?? needsShell });
  if (r.error) {
    throw new Error(`Failed to spawn ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function getElectronVersion() {
  const pkg = JSON.parse(
    await readFile(path.join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')
  );
  return pkg.version;
}

async function download(url, dest) {
  log('download', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// --- 1. Next.js standalone -------------------------------------------------
async function buildNext() {
  log('Building Next.js standalone app…');
  const npm = isWin ? 'npm.cmd' : 'npm';
  const npx = isWin ? 'npx.cmd' : 'npx';

  if (!(await exists(path.join(APP_SRC, 'node_modules')))) {
    run(npm, ['ci'], { cwd: APP_SRC });
  }

  // Rebuild the native better-sqlite3 addon for Electron's ABI *before*
  // `next build`, so the standalone output traces in the Electron-compatible
  // binary. Without this the app crashes opening the DB under
  // ELECTRON_RUN_AS_NODE (Node-ABI vs Electron-ABI mismatch).
  const electronVersion = await getElectronVersion();
  log('Rebuilding better-sqlite3 for Electron', electronVersion);
  run(npx, [
    '--yes',
    '@electron/rebuild',
    '--version', electronVersion,
    '--module-dir', APP_SRC,
    '--only', 'better-sqlite3',
    '--force',
  ], { cwd: APP_SRC });

  // Force the webpack builder for the standalone output. Next 16 defaults
  // `next build` to Turbopack, whose standalone packaging (16.1+) omits
  // externalized node_modules (e.g. axios) or emits hashed external refs
  // that resolve via a separate .next/node_modules which never ends up in
  // the bundle -- the packaged server then crashes at startup with
  // "Failed to load external module axios-<hash>" (vercel/next.js#88844,
  // #91654, #90567). Webpack standalone tracing copies them correctly.
  // `-- --webpack` forwards the flag through the `build` npm script.
  run(npm, ['run', 'build', '--', '--webpack'], {
    cwd: APP_SRC,
    env: { ...process.env, BYH_BUILD_STANDALONE: '1', NODE_ENV: 'production' },
  });

  const standalone = path.join(APP_SRC, '.next', 'standalone');
  if (!(await exists(path.join(standalone, 'server.js')))) {
    throw new Error('Next standalone build did not produce server.js');
  }

  const appOut = path.join(RES, 'app');
  await rm(appOut, { recursive: true, force: true });
  await cp(standalone, appOut, { recursive: true });
  // Next standalone does NOT copy static assets or public/ -- do it manually.
  await cp(path.join(APP_SRC, '.next', 'static'), path.join(appOut, '.next', 'static'), {
    recursive: true,
  });
  if (await exists(path.join(APP_SRC, 'public'))) {
    await cp(path.join(APP_SRC, 'public'), path.join(appOut, 'public'), { recursive: true });
  }
  log('Next app -> resources/app');
}

// --- 2. Embedded Python ----------------------------------------------------
async function buildPython() {
  const key = `${process.platform}-${process.arch}`;
  const triple = PY_TRIPLES[key];
  if (!triple) throw new Error(`No python-build-standalone triple mapped for ${key}`);

  const url =
    process.env.BYH_PYTHON_URL ||
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VER}+${PY_TAG}-${triple}-install_only.tar.gz`;

  const pyOut = path.join(RES, 'python');
  await rm(pyOut, { recursive: true, force: true });
  await mkdir(RES, { recursive: true });

  const tmp = path.join(os.tmpdir(), `byh-python-${Date.now()}.tar.gz`);
  await download(url, tmp);

  // `tar` is available on macOS, Linux, and Windows 10+ (bsdtar). The archive
  // extracts to a top-level `python/` dir.
  log('Extracting Python…');
  run('tar', ['-xzf', tmp, '-C', RES]);
  await rm(tmp, { force: true });

  const pyBin = isWin
    ? path.join(pyOut, 'python.exe')
    : path.join(pyOut, 'bin', 'python3');
  if (!(await exists(pyBin))) throw new Error(`Embedded python missing at ${pyBin}`);

  log('Installing Python requirements into the embedded interpreter…');
  run(pyBin, ['-m', 'pip', 'install', '--upgrade', 'pip']);

  const reqArgs = ['-m', 'pip', 'install'];
  if (INCLUDE_AUDIO) {
    // Full set: services + bridge + firing-profile audio stack.
    reqArgs.push('-r', path.join(HOST_DIR, 'pythings', 'requirements.txt'));
    reqArgs.push('-r', path.join(HOST_DIR, 'tcp_serial_bridge', 'requirements.txt'));
  } else {
    // Lean set: just what the always-on services + bridge need.
    reqArgs.push('-r', path.join(DESKTOP_DIR, 'requirements-core.txt'));
  }
  run(pyBin, reqArgs);
  log('Python -> resources/python');
}

// --- 3. Python sources + config seed --------------------------------------
async function copySources() {
  // Skip Python caches and the dev virtualenv when copying sources.
  const skipPy = (src) =>
    !src.includes('__pycache__') && !src.includes(`${path.sep}venv${path.sep}`) && !src.endsWith(`${path.sep}venv`);

  const pyThingsOut = path.join(RES, 'pythings');
  await rm(pyThingsOut, { recursive: true, force: true });
  await cp(path.join(HOST_DIR, 'pythings'), pyThingsOut, { recursive: true, filter: skipPy });

  const bridgeOut = path.join(RES, 'bridge');
  await rm(bridgeOut, { recursive: true, force: true });
  await cp(path.join(HOST_DIR, 'tcp_serial_bridge'), bridgeOut, { recursive: true, filter: skipPy });

  const cfgOut = path.join(RES, 'config');
  await mkdir(cfgOut, { recursive: true });
  await cp(path.join(HOST_DIR, 'config', 'systemcfg.json'), path.join(cfgOut, 'systemcfg.json'));
  log('Sources + config seed -> resources/');
}

async function main() {
  log(`Platform ${process.platform}/${process.arch}, audio=${INCLUDE_AUDIO}`);
  await mkdir(RES, { recursive: true });
  await buildNext();
  await buildPython();
  await copySources();
  log('Done. Now run: npx electron-builder');
}

main().catch((err) => {
  console.error('[build-resources] FAILED:', err.message);
  process.exit(1);
});
