#!/usr/bin/env node
/**
 * Remediate exercise clips that are ALREADY on BunnyCDN as raw QuickTime
 * `.mov` (Content-Type video/quicktime, moov atom at the tail) — the cause of
 * the flaky Android playback. The original source files are not on this
 * machine, so we fix the live objects in place:
 *
 *   download .mov from the pull zone
 *     → transcode to H.264 faststart .mp4 (scripts/lib/videoTranscode.js)
 *     → verify (moov-before-mdat, h264, size budget)
 *     → upload the .mp4 next to the .mov on Storage (additive; .mov kept)
 *
 * Then optionally repoint references:
 *   --rewrite-manifest  config/video-manifest.json  .mov → .mp4
 *   --db                exercises.video_cdn_path / video_url  .mov → .mp4
 *
 * Targets every `.mov` entry in the manifest by default. Already-fixed objects
 * (a .mp4 twin already exists on the CDN) are skipped unless --force.
 *
 * Usage:
 *   node scripts/transcodeCdnVideos.js [options]
 *
 * Options:
 *   --dry-run               list targets + current sizes (HEAD only); no writes
 *   --only <a,b,..>         only objects whose cdnPath contains one of these
 *   --limit N               cap the number of objects processed
 *   --reencode-mp4-over <MB> also re-encode native .mp4 objects larger than MB
 *   --force                 re-transcode even if a .mp4 twin already exists
 *   --concurrency N         parallel download+transcode+upload (default 3)
 *   --max-width 720         scale cap passed to ffmpeg
 *   --crf 24                x264 quality
 *   --keep-audio            keep AAC audio (default: drop, clips are muted)
 *   --rewrite-manifest      rewrite config/video-manifest.json after success
 *   --db                    repoint the exercises table after success
 *   --manifest <path>       manifest path (default config/video-manifest.json)
 *   --work-dir <dir>        scratch dir (default .tmp_transcode/cdn)
 *   --keep-temps            don't delete downloaded/transcoded temp files
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const transcoder = require('./lib/videoTranscode');

// Lightweight .env loader (shared convention with the other CDN scripts).
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

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    only: null,
    limit: Infinity,
    reencodeMp4Over: Infinity, // MB
    force: false,
    concurrency: 3,
    maxWidth: transcoder.DEFAULTS.maxWidth,
    crf: transcoder.DEFAULTS.crf,
    keepAudio: false,
    rewriteManifest: false,
    db: false,
    manifest: null,
    workDir: null,
    keepTemps: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') opts.limit = Number(argv[++i]) || Infinity;
    else if (a === '--reencode-mp4-over') opts.reencodeMp4Over = Number(argv[++i]) || Infinity;
    else if (a === '--force') opts.force = true;
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]) || 3;
    else if (a === '--max-width') opts.maxWidth = Number(argv[++i]) || opts.maxWidth;
    else if (a === '--crf') opts.crf = Number(argv[++i]) || opts.crf;
    else if (a === '--keep-audio') opts.keepAudio = true;
    else if (a === '--rewrite-manifest') opts.rewriteManifest = true;
    else if (a === '--db') opts.db = true;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--work-dir') opts.workDir = argv[++i];
    else if (a === '--keep-temps') opts.keepTemps = true;
  }
  return opts;
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(1);
}

function encodePath(cdnPath) {
  return cdnPath.split('/').map(encodeURIComponent).join('/');
}

// HEAD a pull-zone URL → { status, contentType, contentLength }.
function head(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 30000 }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || null,
        contentLength: res.headers['content-length']
          ? Number(res.headers['content-length'])
          : null,
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0 });
    });
    req.end();
  });
}

// Stream a URL to disk, following redirects. Resolves bytes written.
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} → ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(fs.statSync(dest).size)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`GET ${url} timed out`));
    });
  });
}

function bunnyPut(cdnPath, localFile, cfg, contentType) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(localFile);
    const req = https.request(
      {
        method: 'PUT',
        host: cfg.storageHostname,
        path: '/' + cfg.storageZone + '/' + encodePath(cdnPath),
        headers: {
          AccessKey: cfg.storagePassword,
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Length': stat.size,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
          else reject(new Error(`PUT ${cdnPath} → ${res.statusCode} ${body.slice(0, 160)}`));
        });
      },
    );
    req.on('error', reject);
    fs.createReadStream(localFile).pipe(req);
  });
}

async function withRetry(fn, attempts, label) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 800 * i));
        process.stderr.write(`  retry ${i}/${attempts - 1} (${label}): ${err.message}\n`);
      }
    }
  }
  throw lastErr;
}

function toMp4Path(cdnPath) {
  return cdnPath.replace(/\.[^./]+$/, '.mp4');
}

// Build the target list from the manifest's videos[] array.
function buildTargets(manifest, opts) {
  const out = [];
  for (const v of manifest.videos || []) {
    const ext = path.extname(v.cdnPath).toLowerCase();
    const isMov = ext === '.mov';
    const isMp4 = ext === '.mp4';
    if (!isMov && !isMp4) continue;
    // .mp4 is only a target when --reencode-mp4-over asks for big ones.
    if (isMp4 && opts.reencodeMp4Over === Infinity) continue;
    if (opts.only && !opts.only.some((s) => v.cdnPath.includes(s))) continue;
    out.push({
      srcCdnPath: v.cdnPath,
      srcUrl: v.url,
      mp4CdnPath: toMp4Path(v.cdnPath),
      isMov,
    });
  }
  return out.slice(0, opts.limit);
}

async function main() {
  const opts = parseArgs(process.argv);
  const manifestPath =
    opts.manifest || path.resolve(__dirname, '..', 'config', 'video-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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

  const workDir = opts.workDir || path.resolve(__dirname, '..', '.tmp_transcode', 'cdn');
  await fsp.mkdir(workDir, { recursive: true });

  let targets = buildTargets(manifest, opts);
  // For --reencode-mp4-over we need each candidate's current size (HEAD).
  if (opts.reencodeMp4Over !== Infinity) {
    const limitBytes = opts.reencodeMp4Over * 1048576;
    const filtered = [];
    for (const t of targets) {
      if (t.isMov) {
        filtered.push(t);
        continue;
      }
      const h = await head(t.srcUrl);
      if (h.contentLength && h.contentLength > limitBytes) filtered.push(t);
    }
    targets = filtered;
  }

  console.log(`Manifest: ${manifestPath}`);
  console.log(`Pull host: ${cfg.pullHostname}  |  Storage zone: ${cfg.storageZone}`);
  console.log(
    `Encode: H.264 faststart, max-width ${opts.maxWidth}, crf ${opts.crf}, audio ${opts.keepAudio ? 'kept' : 'dropped'}`,
  );
  console.log(`Targets: ${targets.length}${opts.only ? ` (filtered by: ${opts.only.join(', ')})` : ''}`);
  console.log(`Work dir: ${workDir}`);
  console.log(`Mode: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}  |  concurrency ${opts.concurrency}\n`);

  if (opts.dryRun) {
    for (const t of targets) {
      const h = await head(t.srcUrl);
      const sz = h.contentLength != null ? `${mb(h.contentLength)} MB` : '??';
      console.log(`  ${t.srcCdnPath}  [${h.status} ${h.contentType || ''} ${sz}]  → ${t.mp4CdnPath}`);
    }
    console.log(`\nDRY-RUN: ${targets.length} object(s) would be transcoded and uploaded.`);
    return;
  }

  const results = []; // { srcCdnPath, srcUrl, mp4CdnPath, mp4Url, ok, srcBytes, outBytes, problems, skipped }
  const queue = targets.slice();
  let done = 0;

  async function processOne(t, workerId) {
    const mp4Url = `https://${cfg.pullHostname}/${encodePath(t.mp4CdnPath)}`;
    const base = `w${workerId}-${t.mp4CdnPath.replace(/[^a-z0-9]+/gi, '_')}`;
    const tmpIn = path.join(workDir, `${base}.src`);
    const tmpOut = path.join(workDir, `${base}.mp4`);
    const rec = { srcCdnPath: t.srcCdnPath, srcUrl: t.srcUrl, mp4CdnPath: t.mp4CdnPath, mp4Url };

    try {
      // Idempotency: skip if the .mp4 twin already exists (unless --force).
      // Only applies when we're creating a NEW object (.mov → .mp4). An
      // in-place re-encode (.mp4 → same .mp4, selected via --reencode-mp4-over)
      // is an intentional overwrite of an already-oversized file, so never skip.
      if (!opts.force && t.mp4CdnPath !== t.srcCdnPath) {
        const existing = await head(mp4Url);
        if (existing.status === 200) {
          rec.ok = true;
          rec.skipped = true;
          results.push(rec);
          console.log(`SKIP [${++done}/${targets.length}] ${t.mp4CdnPath} (already on CDN)`);
          return;
        }
      }

      const srcBytes = await withRetry(() => download(t.srcUrl, tmpIn), 3, `dl ${t.srcCdnPath}`);
      rec.srcBytes = srcBytes;

      const tr = await transcoder.transcode(tmpIn, tmpOut, {
        maxWidth: opts.maxWidth,
        crf: opts.crf,
        keepAudio: opts.keepAudio,
      });
      if (!tr.ok) throw new Error(`ffmpeg exit ${tr.code}: ${tr.stderr.slice(0, 160)}`);

      const v = await transcoder.verify(tmpOut, { maxWidth: opts.maxWidth, crf: opts.crf });
      rec.outBytes = v.sizeBytes;
      rec.problems = v.problems;
      if (!v.faststart) throw new Error('output is not faststart');

      await withRetry(() => bunnyPut(t.mp4CdnPath, tmpOut, cfg, 'video/mp4'), 3, `put ${t.mp4CdnPath}`);
      rec.ok = true;
      results.push(rec);
      console.log(
        `OK   [${++done}/${targets.length}] ${t.mp4CdnPath}  ${mb(srcBytes)}→${mb(v.sizeBytes)} MB` +
          `  ${v.width}x${v.height}${v.problems.length ? `  ⚠ ${v.problems.join('; ')}` : ''}`,
      );
    } catch (err) {
      rec.ok = false;
      rec.error = err.message;
      results.push(rec);
      console.error(`FAIL [${++done}/${targets.length}] ${t.srcCdnPath} :: ${err.message}`);
    } finally {
      if (!opts.keepTemps) {
        for (const f of [tmpIn, tmpOut]) {
          try { await fsp.rm(f, { force: true }); } catch (_) { /* best effort */ }
        }
      }
    }
  }

  async function worker(id) {
    while (queue.length) {
      const t = queue.shift();
      if (!t) return;
      await processOne(t, id);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1)));

  const fixed = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => !r.ok);

  console.log('\n--- summary ---');
  console.log(`fixed=${fixed.length} skipped=${skipped.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  ${f.srcCdnPath} :: ${f.error}`);
  }

  // Optional: repoint the manifest .mov → .mp4 for everything now on the CDN.
  if (opts.rewriteManifest) {
    const repointed = new Set(
      results.filter((r) => r.ok).map((r) => r.srcUrl),
    );
    rewriteManifest(manifest, manifestPath, repointed);
  }

  // Optional: repoint the exercises table.
  if (opts.db) {
    await repointDb(results.filter((r) => r.ok));
  }

  // Write a machine-readable report next to the work dir for the record.
  const reportPath = path.join(workDir, 'transcode-report.json');
  await fsp.writeFile(reportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Report: ${reportPath}`);

  if (failed.length) process.exitCode = 2;
}

// Swap .mov → .mp4 in videos[] and byBaseSlug for the given source URLs.
function rewriteManifest(manifest, manifestPath, repointedSrcUrls) {
  fs.copyFileSync(manifestPath, `${manifestPath}.bak`);
  let count = 0;

  for (const v of manifest.videos || []) {
    if (repointedSrcUrls.has(v.url)) {
      v.cdnPath = toMp4Path(v.cdnPath);
      v.url = toMp4Path(v.url);
      v.source = toMp4Path(v.source);
      count++;
    }
  }
  const swap = (url) => (repointedSrcUrls.has(url) ? toMp4Path(url) : url);
  for (const key of Object.keys(manifest.byBaseSlug || {})) {
    const val = manifest.byBaseSlug[key];
    manifest.byBaseSlug[key] = Array.isArray(val) ? val.map(swap) : swap(val);
  }
  manifest.videos.sort((a, b) => a.cdnPath.localeCompare(b.cdnPath));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Manifest rewritten: ${count} video entr${count === 1 ? 'y' : 'ies'} .mov → .mp4 (backup: ${path.basename(manifestPath)}.bak)`);
}

// Repoint exercises.video_cdn_path / video_url for each fixed object.
async function repointDb(okResults) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  let affected = 0;
  try {
    for (const r of okResults) {
      const [res] = await conn.execute(
        `UPDATE exercises
            SET video_cdn_path = ?, video_url = ?
          WHERE video_cdn_path = ? OR video_url = ?`,
        [r.mp4CdnPath, r.mp4Url, r.srcCdnPath, r.srcUrl],
      );
      affected += res.affectedRows || 0;
    }
    console.log(`DB repoint: ${affected} exercise row(s) updated .mov → .mp4`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
