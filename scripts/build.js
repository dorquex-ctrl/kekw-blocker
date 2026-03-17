#!/usr/bin/env node
/**
 * Build script for KEKW Blocker browser extension.
 *
 * Usage:
 *   node scripts/build.js chrome          Build for Chrome/Brave
 *   node scripts/build.js firefox         Build for Firefox
 *   node scripts/build.js firefox --zip   Build and create .zip archive
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const target = args.find(a => a !== '--zip');
const shouldZip = args.includes('--zip');

if (!target || !['chrome', 'firefox'].includes(target)) {
  console.error('Usage: node scripts/build.js <chrome|firefox> [--zip]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', target);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove a directory tree (rm -rf). */
function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Create directory tree (mkdir -p). */
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Copy a single file, creating parent dirs as needed. */
function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Recursively copy a directory, applying an optional filter.
 * @param {string} src  - source directory
 * @param {string} dest - destination directory
 * @param {(relPath: string) => boolean} [filter] - return false to skip
 */
function copyDir(src, dest, filter) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = path.relative(ROOT, srcPath);

    if (filter && !filter(rel, entry)) continue;

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Exclusion / inclusion rules
// ---------------------------------------------------------------------------

/** Directories and files to exclude from the build. */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.github', 'scripts', 'dist']);
const EXCLUDE_FILES = new Set(['manifest.firefox.json', 'remote-config.json', 'README.md', 'LICENSE', 'SECURITY.md', '.gitignore', 'package.json', 'package-lock.json']);

function globalFilter(relPath, entry) {
  const name = entry.name;

  // Skip excluded top-level directories.
  if (entry.isDirectory() && EXCLUDE_DIRS.has(name)) return false;

  // Skip SVG files.
  if (!entry.isDirectory() && name.endsWith('.svg')) return false;

  // Skip specific excluded files (at any depth).
  if (!entry.isDirectory() && EXCLUDE_FILES.has(name)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

console.log(`Building for ${target}...`);

// 1. Clean previous build.
rmrf(DIST);
mkdirp(DIST);

// 2. Copy all qualifying files from the project root.
const topEntries = fs.readdirSync(ROOT, { withFileTypes: true });

for (const entry of topEntries) {
  const name = entry.name;
  const srcPath = path.join(ROOT, name);
  const destPath = path.join(DIST, name);

  // Skip excluded top-level dirs / files.
  if (entry.isDirectory() && EXCLUDE_DIRS.has(name)) continue;
  if (!entry.isDirectory() && EXCLUDE_FILES.has(name)) continue;
  if (!entry.isDirectory() && name.endsWith('.svg')) continue;

  // Skip package.json / package-lock.json — not part of the extension.
  if (name === 'package.json' || name === 'package-lock.json') continue;

  // Skip the source manifest (we handle it separately below).
  if (name === 'manifest.json' || name === 'manifest.firefox.json') continue;

  if (entry.isDirectory()) {
    copyDir(srcPath, destPath, globalFilter);
  } else {
    copyFile(srcPath, destPath);
  }
}

// 3. Copy the correct manifest as manifest.json.
const manifestSrc = target === 'firefox'
  ? path.join(ROOT, 'manifest.firefox.json')
  : path.join(ROOT, 'manifest.json');

if (!fs.existsSync(manifestSrc)) {
  console.error(`Manifest not found: ${manifestSrc}`);
  process.exit(1);
}

copyFile(manifestSrc, path.join(DIST, 'manifest.json'));

// 4. Report output.
const fileCount = countFiles(DIST);
console.log(`Copied ${fileCount} files to dist/${target}/`);

// 5. Optionally zip.
if (shouldZip) {
  const zipName = `ttv-adblock-${target}-v${getVersion()}.zip`;
  const zipPath = path.join(ROOT, 'dist', zipName);

  // Remove previous zip if it exists.
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  try {
    // Use the platform zip utility. PowerShell is available on Windows;
    // `zip` is available on most Unix systems.
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${DIST}\\*' -DestinationPath '${zipPath}'"`,
        { stdio: 'inherit' }
      );
    } else {
      execSync(`cd "${DIST}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
    }
    console.log(`Zipped to dist/${zipName}`);
  } catch (err) {
    console.error('Failed to create zip:', err.message);
    process.exit(1);
  }
}

console.log('Done.');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function countFiles(dir) {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

function getVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf-8'));
    return manifest.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
