#!/usr/bin/env node
/**
 * Build script for KEKW Blocker browser extension.
 *
 * Usage:
 *   node scripts/build.js chrome               Build for Chrome/Brave
 *   node scripts/build.js firefox              Build Firefox dev/debug package
 *   node scripts/build.js firefox-amo          Build Firefox AMO submission package
 *   node scripts/build.js <target> --zip       Build and create a .zip archive
 *   node scripts/build.js <firefox-target> --xpi
 *                                             Build and create a .xpi archive
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const target = args.find((arg) => arg !== '--zip' && arg !== '--xpi');
const shouldZip = args.includes('--zip');
const shouldXpi = args.includes('--xpi');
const VALID_TARGETS = new Set(['chrome', 'firefox', 'firefox-amo']);
const ROOT = path.resolve(__dirname, '..');

if (!target || !VALID_TARGETS.has(target)) {
  console.error('Usage: node scripts/build.js <chrome|firefox|firefox-amo> [--zip|--xpi]');
  process.exit(1);
}

if (shouldXpi && !target.startsWith('firefox')) {
  console.error('--xpi is only supported for Firefox targets');
  process.exit(1);
}

const DIST = path.join(ROOT, 'dist', target);
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.github', 'scripts', 'dist', 'docs']);
const EXCLUDE_FILES = new Set([
  'manifest.firefox.json',
  'manifest.firefox.amo.json',
  'remote-config.json',
  'rules.json',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'PRIVACY.md',
  '.gitignore',
  'package.json',
  'package-lock.json'
]);

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, filter) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = path.relative(ROOT, srcPath);

    if (filter && !filter(rel, entry)) continue;

    if (entry.isDirectory()) copyDir(srcPath, destPath, filter);
    else copyFile(srcPath, destPath);
  }
}

function globalFilter(relPath, entry) {
  const name = entry.name;
  if (entry.isDirectory() && EXCLUDE_DIRS.has(name)) return false;
  if (!entry.isDirectory() && name.endsWith('.svg')) return false;
  if (!entry.isDirectory() && EXCLUDE_FILES.has(name)) return false;
  return true;
}

function getManifestPath(selectedTarget) {
  if (selectedTarget === 'firefox') return path.join(ROOT, 'manifest.firefox.json');
  if (selectedTarget === 'firefox-amo') return path.join(ROOT, 'manifest.firefox.amo.json');
  return path.join(ROOT, 'manifest.json');
}

function countFiles(dir) {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

function getVersion(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return manifest.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function createArchive(archivePath) {
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  if (process.platform === 'win32') {
    const zipArchivePath = archivePath.endsWith('.xpi')
      ? archivePath.replace(/\.xpi$/i, '.zip')
      : archivePath;
    if (zipArchivePath !== archivePath && fs.existsSync(zipArchivePath)) fs.unlinkSync(zipArchivePath);
    execSync(
      `powershell -NoProfile -Command "Set-Location '${DIST}'; tar -a -c -f '${zipArchivePath}' *"`,
      { stdio: 'inherit' }
    );
    if (zipArchivePath !== archivePath) fs.renameSync(zipArchivePath, archivePath);
    return;
  }
  execSync(`cd "${DIST}" && zip -r "${archivePath}" .`, { stdio: 'inherit' });
}

console.log(`Building for ${target}...`);

rmrf(DIST);
mkdirp(DIST);

const topEntries = fs.readdirSync(ROOT, { withFileTypes: true });
for (const entry of topEntries) {
  const name = entry.name;
  const srcPath = path.join(ROOT, name);
  const destPath = path.join(DIST, name);

  if (entry.isDirectory() && EXCLUDE_DIRS.has(name)) continue;
  if (!entry.isDirectory() && EXCLUDE_FILES.has(name)) continue;
  if (!entry.isDirectory() && name.endsWith('.svg')) continue;
  if (name === 'manifest.json' || name === 'manifest.firefox.json' || name === 'manifest.firefox.amo.json') continue;

  if (entry.isDirectory()) copyDir(srcPath, destPath, globalFilter);
  else copyFile(srcPath, destPath);
}

const manifestSrc = getManifestPath(target);
if (!fs.existsSync(manifestSrc)) {
  console.error(`Manifest not found: ${manifestSrc}`);
  process.exit(1);
}

copyFile(manifestSrc, path.join(DIST, 'manifest.json'));

// Copy DNR rules for Manifest V3
const rulesSrc = path.join(ROOT, 'rules.json');
if (fs.existsSync(rulesSrc)) {
  copyFile(rulesSrc, path.join(DIST, 'rules.json'));
}

const fileCount = countFiles(DIST);
console.log(`Copied ${fileCount} files to dist/${target}/`);

if (shouldZip || shouldXpi) {
  const archiveExt = shouldXpi ? 'xpi' : 'zip';
  const archiveName = `ttv-adblock-${target}-v${getVersion(manifestSrc)}.${archiveExt}`;
  const archivePath = path.join(ROOT, 'dist', archiveName);
  try {
    createArchive(archivePath);
    console.log(`Archived to dist/${archiveName}`);
  } catch (err) {
    console.error('Failed to create archive:', err.message);
    process.exit(1);
  }
}

console.log('Done.');
