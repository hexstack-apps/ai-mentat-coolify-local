#!/usr/bin/env node
/**
 * Downloads Lima binaries for bundling with the app.
 * Usage: node scripts/download-lima.js
 *
 * Downloads to lima-bin/ directory. Required on macOS builds (Docker mode).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LIMA_VERSION = '1.0.5';
const LIMA_DIR = path.join(__dirname, '..', 'lima-bin');

function getArch() {
  const arch = process.arch;
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'x64') return 'x86_64';
  throw new Error(`Unsupported architecture: ${arch}`);
}

function getPlatform() {
  if (process.platform === 'darwin') return 'Darwin';
  if (process.platform === 'linux') return 'Linux';
  throw new Error(`Lima is only supported on macOS and Linux, not ${process.platform}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(dest);
    const request = (url) => {
      https.get(url, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          request(resp.headers.location);
          return;
        }
        if (resp.statusCode !== 200) {
          reject(new Error(`HTTP ${resp.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(resp.headers['content-length'] || '0', 10);
        let downloaded = 0;
        resp.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) process.stdout.write(`\r  ${Math.round(downloaded / total * 100)}%`);
        });
        resp.pipe(file);
        file.on('finish', () => { file.close(); console.log(' done'); resolve(); });
      }).on('error', reject);
    };
    request(url);
  });
}

async function main() {
  const platform = getPlatform();
  const arch = getArch();

  console.log(`Downloading Lima ${LIMA_VERSION} for ${platform}-${arch}...`);

  if (fs.existsSync(LIMA_DIR) && !fs.lstatSync(LIMA_DIR).isSymbolicLink()) fs.rmSync(LIMA_DIR, { recursive: true });
  if (fs.existsSync(LIMA_DIR)) fs.unlinkSync(LIMA_DIR);
  fs.mkdirSync(LIMA_DIR, { recursive: true });

  const tarball = `lima-${LIMA_VERSION}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/${tarball}`;
  const tarPath = path.join(LIMA_DIR, tarball);

  await download(url, tarPath);

  console.log('Extracting...');
  execSync(`tar xzf "${tarball}"`, { cwd: LIMA_DIR });
  fs.unlinkSync(tarPath);

  const limactlPath = path.join(LIMA_DIR, 'bin', 'limactl');
  if (fs.existsSync(limactlPath)) {
    const version = execSync(`"${limactlPath}" --version`, { stdio: 'pipe' }).toString().trim();
    console.log(`Lima installed to ${LIMA_DIR} (${version})`);
  } else {
    console.error('ERROR: limactl not found after extraction');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
