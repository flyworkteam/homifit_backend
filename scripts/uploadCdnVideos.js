#!/usr/bin/env node
/**
 * Upload all video files in a local folder to BunnyCDN Storage and emit a
 * JSON manifest the backend can consult to resolve "exercise name → CDN URL".
 *
 * Every clip is normalized for progressive HTTP streaming before upload:
 * re-encoded to H.264 (yuv420p) MP4 with the `moov` atom at the front
 * (`-movflags +faststart`) and capped to ~720p so each file is ~1–5MB. This
 * is what makes the videos load reliably on Android (ExoPlayer needs `moov`
 * before the first frame). A source that is *already* a faststart H.264 MP4
 * within budget is uploaded as-is (pass-through) unless --force-transcode.
 * See scripts/lib/videoTranscode.js for the encode recipe.
 *
 * Usage:
 *   node scripts/uploadCdnVideos.js <local-root> [--manifest <path>] [--concurrency N] [--dry-run]
 *                                   [--no-transcode] [--force-transcode]
 *                                   [--max-width 720] [--crf 24] [--keep-audio]
 *                                   [--work-dir <dir>]
 *
 * Reads BunnyCDN credentials from environment (BUNNY_STORAGE_ZONE,
 * BUNNY_STORAGE_PASSWORD, BUNNY_STORAGE_HOSTNAME, BUNNY_PULL_HOSTNAME).
 * Auto-loads .env from the backend root if present.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const transcoder = require('./lib/videoTranscode');

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

/**
 * Slugify a relative path. When `forceExt` is given (e.g. '.mp4'), the output
 * extension is forced to it regardless of the source — used so transcoded
 * clips publish as `.mp4` even when the source was `.mov`.
 */
function slugifyPath(relPath, forceExt) {
  const parts = relPath.split(path.sep);
  const file = parts.pop();
  const ext = forceExt || path.extname(file).toLowerCase();
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

function bunnyPut(cdnPath, localFile, accessKey, host, zone, contentType) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(localFile);
    const req = https.request(
      {
        method: 'PUT',
        host,
        path: '/' + zone + '/' + cdnPath.split('/').map(encodeURIComponent).join('/'),
        headers: {
          AccessKey: accessKey,
          'Content-Type': contentType || 'application/octet-stream',
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
  const opts = {
    root: null,
    manifest: null,
    concurrency: 4,
    dryRun: false,
    transcode: true,
    forceTranscode: false,
    maxWidth: transcoder.DEFAULTS.maxWidth,
    crf: transcoder.DEFAULTS.crf,
    keepAudio: false,
    workDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]) || 4;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-transcode') opts.transcode = false;
    else if (a === '--force-transcode') opts.forceTranscode = true;
    else if (a === '--max-width') opts.maxWidth = Number(argv[++i]) || opts.maxWidth;
    else if (a === '--crf') opts.crf = Number(argv[++i]) || opts.crf;
    else if (a === '--keep-audio') opts.keepAudio = true;
    else if (a === '--work-dir') opts.workDir = argv[++i];
    else if (!opts.root) opts.root = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.root) {
    console.error(
      'Usage: node scripts/uploadCdnVideos.js <local-root> [--manifest <path>] [--concurrency N] [--dry-run]\n' +
        '       [--no-transcode] [--force-transcode] [--max-width 720] [--crf 24] [--keep-audio] [--work-dir <dir>]',
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
  const workDir =
    opts.workDir || path.resolve(__dirname, '..', '.tmp_transcode', 'upload');
  if (opts.transcode) {
    await fsp.mkdir(workDir, { recursive: true });
  }

  // Collect everything first so we can show progress. When transcoding, the
  // published cdnPath always ends in `.mp4`.
  const items = [];
  for await (const local of walkVideos(root)) {
    const rel = path.relative(root, local);
    const cdnPath = slugifyPath(rel, opts.transcode ? '.mp4' : undefined);
    items.push({ local, rel, cdnPath });
  }
  console.log(`Discovered ${items.length} video files under ${root}`);
  console.log(
    opts.transcode
      ? `Transcode: ON (H.264 faststart, max-width ${opts.maxWidth}, crf ${opts.crf}, audio ${opts.keepAudio ? 'kept' : 'dropped'})`
      : 'Transcode: OFF (uploading sources as-is)',
  );

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
  const transcodeOpts = {
    maxWidth: opts.maxWidth,
    crf: opts.crf,
    keepAudio: opts.keepAudio,
  };

  // Resolve which local file to upload for an item, transcoding if needed.
  // Returns { file, temp } where `temp` (if set) should be cleaned up after.
  async function prepareUpload(it, workerId) {
    if (!opts.transcode) return { file: it.local, temp: null };

    const ext = path.extname(it.local).toLowerCase();
    // Pass-through: an existing faststart H.264 mp4 within budget is fine as-is.
    if (ext === '.mp4' && !opts.forceTranscode) {
      const v = await transcoder.verify(it.local, transcodeOpts);
      if (v.ok) return { file: it.local, temp: null, passthrough: true };
    }
    const temp = path.join(workDir, `w${workerId}-${slugify(it.cdnPath)}.mp4`);
    const t = await transcoder.transcode(it.local, temp, transcodeOpts);
    if (!t.ok) {
      throw new Error(`transcode failed (ffmpeg exit ${t.code}): ${t.stderr.slice(0, 200)}`);
    }
    const v = await transcoder.verify(temp, transcodeOpts);
    if (!v.faststart) {
      throw new Error('transcode produced a non-faststart file');
    }
    if (v.problems.length) {
      process.stderr.write(`  ! ${it.cdnPath}: ${v.problems.join('; ')}\n`);
    }
    return { file: temp, temp };
  }

  // Simple parallel pool.
  const queue = items.slice();
  async function worker(id) {
    while (queue.length) {
      const it = queue.shift();
      if (!it) return;
      const idx = items.indexOf(it) + 1;
      const srcMB = (fs.statSync(it.local).size / (1024 * 1024)).toFixed(1);
      const label = `[${idx}/${items.length}][w${id}] ${it.cdnPath} (src ${srcMB} MB)`;
      let prepared = null;
      try {
        if (opts.dryRun) {
          console.log(`DRY  ${label}`);
        } else {
          prepared = await prepareUpload(it, id);
          const outMB = (fs.statSync(prepared.file).size / (1024 * 1024)).toFixed(1);
          await withRetry(
            () =>
              bunnyPut(
                it.cdnPath,
                prepared.file,
                cfg.storagePassword,
                cfg.storageHostname,
                cfg.storageZone,
                'video/mp4',
              ),
            3,
            it.cdnPath,
          );
          console.log(
            `OK   ${label} → ${outMB} MB${prepared.passthrough ? ' (passthrough)' : ''}`,
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
      } catch (err) {
        failed++;
        console.error(`FAIL ${label} :: ${err.message}`);
      } finally {
        // Drop the temp transcode to keep the work dir small.
        if (prepared && prepared.temp) {
          try {
            await fsp.rm(prepared.temp, { force: true });
          } catch (_) {
            /* best effort */
          }
        }
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
