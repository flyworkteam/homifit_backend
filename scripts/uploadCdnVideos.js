#!/usr/bin/env node
/**
 * Upload all video files in a local folder to BunnyCDN Storage and emit a
 * JSON manifest the backend can consult to resolve "exercise name → CDN URL".
 *
 * Usage:
 *   node scripts/uploadCdnVideos.js <local-root> [--manifest <path>] [--concurrency N] [--dry-run]
 *
 * Reads BunnyCDN credentials from environment (BUNNY_STORAGE_ZONE,
 * BUNNY_STORAGE_PASSWORD, BUNNY_STORAGE_HOSTNAME, BUNNY_PULL_HOSTNAME).
 * Auto-loads .env from the backend root if present.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

// Lightweight .env loader (no dotenv dep needed for a one-off script).
(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
})();

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']);

const TURKISH_MAP = {
  'ı': 'i', 'I': 'I', 'İ': 'I',
  'ğ': 'g', 'Ğ': 'G',
  'ş': 's', 'Ş': 'S',
  'ö': 'o', 'Ö': 'O',
  'ü': 'u', 'Ü': 'U',
  'ç': 'c', 'Ç': 'C',
};

function slugify(value) {
  let out = '';
  for (const ch of String(value)) {
    out += TURKISH_MAP[ch] !== undefined ? TURKISH_MAP[ch] : ch;
  }
  return out
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip remaining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugifyPath(relPath) {
  const parts = relPath.split(path.sep);
  const file = parts.pop();
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file));
  const slugBase = slugify(base);
  const slugDir = parts.map(slugify).filter(Boolean).join('/');
  const cdnPath = (slugDir ? `${slugDir}/` : '') + slugBase + ext;
  return cdnPath;
}

async function* walkVideos(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXT.has(ext)) yield full;
      }
    }
  }
}

function bunnyPut(cdnPath, localFile, accessKey, host, zone) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(localFile);
    const req = https.request(
      {
        method: 'PUT',
        host,
        path: '/' + zone + '/' + cdnPath.split('/').map(encodeURIComponent).join('/'),
        headers: {
          AccessKey: accessKey,
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            reject(
              new Error(
                `Bunny PUT ${cdnPath} failed: ${res.statusCode} ${body.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    fs.createReadStream(localFile).pipe(req);
  });
}

async function withRetry(fn, attempts = 3, label = '') {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const wait = 500 * i;
        process.stderr.write(`  retry ${i}/${attempts - 1} after ${wait}ms (${label}): ${err.message}\n`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const opts = { root: null, manifest: null, concurrency: 4, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]) || 4;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (!opts.root) opts.root = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.root) {
    console.error(
      'Usage: node scripts/uploadCdnVideos.js <local-root> [--manifest <path>] [--concurrency N] [--dry-run]',
    );
    process.exit(1);
  }
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) {
    console.error(`Local root does not exist: ${root}`);
    process.exit(1);
  }

  const cfg = {
    storageZone: process.env.BUNNY_STORAGE_ZONE,
    storagePassword: process.env.BUNNY_STORAGE_PASSWORD,
    storageHostname: process.env.BUNNY_STORAGE_HOSTNAME || 'storage.bunnycdn.com',
    pullHostname: process.env.BUNNY_PULL_HOSTNAME,
  };
  if (!opts.dryRun) {
    for (const k of ['storageZone', 'storagePassword', 'pullHostname']) {
      if (!cfg[k]) {
        console.error(`Missing env: ${k}`);
        process.exit(1);
      }
    }
  }

  const manifestPath =
    opts.manifest || path.resolve(__dirname, '..', 'config', 'video-manifest.json');

  // Collect everything first so we can show progress.
  const items = [];
  for await (const local of walkVideos(root)) {
    const rel = path.relative(root, local);
    const cdnPath = slugifyPath(rel);
    items.push({ local, rel, cdnPath });
  }
  console.log(`Discovered ${items.length} video files under ${root}`);

  // Slug collision check.
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.cdnPath)) {
      console.warn(`! Slug collision: ${it.cdnPath}\n    A: ${seen.get(it.cdnPath)}\n    B: ${it.rel}`);
    } else {
      seen.set(it.cdnPath, it.rel);
    }
  }

  // Manifest entries: keyed by file slug (e.g. "bodyweight-squat") AND full path.
  const manifest = {
    generatedAt: new Date().toISOString(),
    pullHostname: cfg.pullHostname,
    storageZone: cfg.storageZone,
    videos: [],
    byBaseSlug: {}, // first-seen wins; ambiguous keys stored as arrays
  };

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  // Simple parallel pool.
  const queue = items.slice();
  async function worker(id) {
    while (queue.length) {
      const it = queue.shift();
      if (!it) return;
      const idx = items.indexOf(it) + 1;
      const sizeMB = (fs.statSync(it.local).size / (1024 * 1024)).toFixed(1);
      const label = `[${idx}/${items.length}][w${id}] ${it.cdnPath} (${sizeMB} MB)`;
      try {
        if (!opts.dryRun) {
          await withRetry(
            () =>
              bunnyPut(
                it.cdnPath,
                it.local,
                cfg.storagePassword,
                cfg.storageHostname,
                cfg.storageZone,
              ),
            3,
            it.cdnPath,
          );
        }
        const url = `https://${cfg.pullHostname}/${it.cdnPath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        manifest.videos.push({
          source: it.rel.replace(/\\/g, '/'),
          cdnPath: it.cdnPath,
          url,
        });
        const baseSlug = path.basename(it.cdnPath, path.extname(it.cdnPath));
        if (manifest.byBaseSlug[baseSlug] === undefined) {
          manifest.byBaseSlug[baseSlug] = url;
        } else if (Array.isArray(manifest.byBaseSlug[baseSlug])) {
          manifest.byBaseSlug[baseSlug].push(url);
        } else {
          manifest.byBaseSlug[baseSlug] = [manifest.byBaseSlug[baseSlug], url];
        }
        uploaded++;
        console.log(`OK   ${label}`);
      } catch (err) {
        failed++;
        console.error(`FAIL ${label} :: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  manifest.videos.sort((a, b) => a.cdnPath.localeCompare(b.cdnPath));
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('---');
  console.log(`Done. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  console.log(`Manifest: ${manifestPath}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
