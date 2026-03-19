#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(DIST, 'source-package');
const EXCLUDE_DIRS = new Set(['.git', 'dist', 'node_modules']);
const EXCLUDE_FILES = new Set([]);

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      copyDir(srcPath, destPath);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      copyFile(srcPath, destPath);
    }
  }
}

function getVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.firefox.amo.json'), 'utf8'));
  return manifest.version || '0.0.0';
}

function createZip(sourceDir, archivePath) {
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Set-Location '${sourceDir}'; tar -a -c -f '${archivePath}' *"`,
      { stdio: 'inherit' }
    );
    return;
  }
  execSync(`cd "${sourceDir}" && zip -r "${archivePath}" .`, { stdio: 'inherit' });
}

mkdirp(DIST);
rmrf(TMP);
mkdirp(TMP);
copyDir(ROOT, TMP);

const archivePath = path.join(DIST, `ttv-adblock-source-v${getVersion()}.zip`);
createZip(TMP, archivePath);
rmrf(TMP);

console.log(`Created ${path.relative(ROOT, archivePath)}`);
