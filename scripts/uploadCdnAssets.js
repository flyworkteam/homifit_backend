#!/usr/bin/env node
/**
 * Upload all image assets under a local folder to BunnyCDN Storage and emit
 * a JSON manifest mapping the Flutter asset path ('assets/images/X.png') →
 * BunnyCDN pull URL.
 *
 * Usage:
 *   node scripts/uploadCdnAssets.js <local-root> [--out <manifest-path>] [--prefix <cdn-prefix>] [--concurrency N] [--dry-run]
 *
 * Defaults:
 *   <local-root>      ../homifit/assets/images          (resolved relative to script)
 *   --out             ../homifit/assets/cdn_manifest.json
 *   --prefix          assets                            (so CDN path = <prefix>/<rel slugified>)
 *   --concurrency     6
 *
 * Skips the following directories (kept local for offline / boot UX):
 *   splash/  loading/  icons/   (icons subtree is mostly SVG anyway)
 * Skips .svg files entirely (small, cheap to bundle).
 *
 * Reads BunnyCDN credentials from environment / .env at the backend root:
 *   BUNNY_STORAGE_ZONE
 *   BUNNY_STORAGE_PASSWORD
 *   BUNNY_STORAGE_HOSTNAME    (default: storage.bunnycdn.com)
 *   BUNNY_PULL_HOSTNAME       (e.g. homifit.b-cdn.net)
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

// Lightweight .env loader (no dotenv dep needed).
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

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SKIP_DIRS = new Set(['splash', 'loading', 'icons']);

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
    .replace(/[̀-ͯ]/g, '')
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
  return (slugDir ? `${slugDir}/` : '') + slugBase + ext;
}

async function* walkImages(root, skipDirs) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip top-level "splash", "loading", "icons" dirs.
        if (depth === 0 && skipDirs.has(entry.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXT.has(ext)) yield full;
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
            reject(new Error(`Bunny PUT ${cdnPath} failed: ${res.statusCode} ${body.slice(0, 200)}`));
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
  const opts = {
    root: null,
    out: null,
    prefix: 'assets',
    concurrency: 6,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--prefix') opts.prefix = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]) || 6;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (!opts.root) opts.root = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const root = path.resolve(
    opts.root || path.resolve(__dirname, '..', '..', 'homifit', 'assets', 'images'),
  );
  const out = path.resolve(
    opts.out || path.resolve(__dirname, '..', '..', 'homifit', 'assets', 'cdn_manifest.json'),
  );

  if (!fs.existsSync(root)) {
    console.error(`Root not found: ${root}`);
    process.exit(1);
  }

  const zone = process.env.BUNNY_STORAGE_ZONE;
  const accessKey = process.env.BUNNY_STORAGE_PASSWORD;
  const storageHost = process.env.BUNNY_STORAGE_HOSTNAME || 'storage.bunnycdn.com';
  const pullHost = process.env.BUNNY_PULL_HOSTNAME;

  if (!opts.dryRun && (!zone || !accessKey || !pullHost)) {
    console.error('Missing BUNNY_STORAGE_ZONE / BUNNY_STORAGE_PASSWORD / BUNNY_PULL_HOSTNAME in env');
    process.exit(1);
  }

  console.log(`Scanning ${root}`);
  console.log(`Skipping top-level dirs: ${[...SKIP_DIRS].join(', ')}`);
  console.log(`CDN prefix: ${opts.prefix}/`);
  console.log(`Manifest output: ${out}`);
  console.log(`Dry-run: ${opts.dryRun}`);

  const files = [];
  for await (const f of walkImages(root, SKIP_DIRS)) files.push(f);
  console.log(`Found ${files.length} images`);

  // Build the upload plan upfront so we can show progress + dedupe.
  const plan = files.map((local) => {
    const rel = path.relative(root, local);                // onboarding/welcome.png
    const cdnPath = `${opts.prefix}/${slugifyPath(rel)}`;  // assets/onboarding/welcome.png
    // Flutter-side asset key (as used in code: 'assets/images/onboarding/welcome.png')
    const flutterKey = `assets/images/${rel.split(path.sep).join('/')}`;
    const pullUrl = `https://${pullHost || '<pull-host>'}/${cdnPath}`;
    return { local, rel, cdnPath, flutterKey, pullUrl };
  });

  const manifest = {};
  let ok = 0, fail = 0, skipped = 0;
  const t0 = Date.now();

  // Concurrency-bounded uploader.
  let cursor = 0;
  async function worker(id) {
    while (cursor < plan.length) {
      const idx = cursor++;
      const item = plan[idx];
      const label = `[${idx + 1}/${plan.length}] ${item.rel}`;
      if (opts.dryRun) {
        console.log(`DRY ${label} → ${item.cdnPath}`);
        manifest[item.flutterKey] = item.pullUrl;
        ok++;
        continue;
      }
      try {
        await withRetry(
          () => bunnyPut(item.cdnPath, item.local, accessKey, storageHost, zone),
          3,
          label,
        );
        manifest[item.flutterKey] = item.pullUrl;
        ok++;
        if (ok % 10 === 0) {
          console.log(`  ✓ uploaded ${ok}/${plan.length}`);
        }
      } catch (err) {
        console.error(`  ✗ ${label}: ${err.message}`);
        fail++;
      }
    }
  }

  const workers = Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const sortedManifest = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, JSON.stringify(sortedManifest, null, 2));

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${dt}s: ${ok} uploaded, ${fail} failed, ${skipped} skipped`);
  console.log(`Manifest written: ${out}  (${Object.keys(sortedManifest).length} entries)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
