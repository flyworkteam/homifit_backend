#!/usr/bin/env node
/**
 * Regenerate per-exercise poster thumbnails at a crisp resolution and wire them
 * up so the app actually shows a DISTINCT image per exercise.
 *
 * Why: exercises.thumbnail_path was NULL for every row, so the API returned
 * thumbnailUrl=null and the Flutter UI fell back to a tiny shared library —
 * the same picture appeared for many different exercises (and the workout
 * detail screen showed one hardcoded placeholder for ALL moves). Separately,
 * ~25 of the old CDN thumbnails were only 240px wide (blurry when scaled up).
 *
 * This script extracts a fresh frame from each exercise's (now 720p faststart)
 * video, uploads it to a NEW, never-cached CDN prefix, and sets
 * exercises.thumbnail_path so buildVideoUrl() resolves to a real per-exercise
 * image. A new prefix avoids the BunnyCDN cache-on-overwrite gotcha (the old
 * assets/exercise-thumbs/* URLs are edge-cached).
 *
 * Usage:
 *   node scripts/regenerateThumbnails.js [--dry-run] [--db] [--only <substr>]
 *        [--limit N] [--concurrency N] [--prefix exercise-thumbs] [--width 720]
 *        [--force] [--work-dir <dir>]
 *
 * --db writes exercises.thumbnail_path. Without it, only uploads happen.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const transcoder = require('./lib/videoTranscode');

(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) process.env[key] = value.replace(/^['"]|['"]$/g, '');
  }
})();

function parseArgs(argv) {
  const o = {
    dryRun: false, db: false, only: null, limit: Infinity,
    concurrency: 4, prefix: 'exercise-thumbs', width: 720, force: false, workDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--db') o.db = true;
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]) || Infinity;
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]) || 4;
    else if (a === '--prefix') o.prefix = argv[++i];
    else if (a === '--width') o.width = Number(argv[++i]) || 720;
    else if (a === '--force') o.force = true;
    else if (a === '--work-dir') o.workDir = argv[++i];
  }
  return o;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const mb = (b) => (b / 1048576).toFixed(2);

// Extract a single JPEG frame (~0.8s in) at the given width from a video URL.
function extractFrame(url, outPath, width) {
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-ss', '00:00:00.8',
      '-i', url,
      '-frames:v', '1',
      '-vf', `scale='min(${width},iw)':-2`,
      '-q:v', '3',
      '-loglevel', 'error',
      outPath,
    ];
    const proc = spawn(transcoder.ffmpegBin(), args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stderr: String(err) }));
  });
}

function head(url) {
  return new Promise((r) => {
    https.request(url, { method: 'HEAD', timeout: 30000 }, (res) => {
      res.resume();
      r({ status: res.statusCode, len: +res.headers['content-length'] || 0 });
    }).on('error', () => r({ status: 0 })).end();
  });
}

function bunnyPut(cfg, objPath, localFile, contentType) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(localFile);
    const req = https.request(
      { method: 'PUT', host: cfg.storageHostname, path: '/' + cfg.storageZone + '/' + encodePath(objPath),
        headers: { AccessKey: cfg.storagePassword, 'Content-Type': contentType || 'application/octet-stream', 'Content-Length': stat.size } },
      (res) => {
        const ch = []; res.on('data', (c) => ch.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
          else reject(new Error(`PUT ${objPath} → ${res.statusCode} ${Buffer.concat(ch).toString().slice(0, 160)}`));
        });
      },
    );
    req.on('error', reject);
    fs.createReadStream(localFile).pipe(req);
  });
}

// Read JPEG dimensions from the file header (no decode lib needed).
function jpegSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 131072));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF markers carry the frame dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { width, height };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const cfg = {
    storageZone: process.env.BUNNY_STORAGE_ZONE,
    storagePassword: process.env.BUNNY_STORAGE_PASSWORD,
    storageHostname: process.env.BUNNY_STORAGE_HOSTNAME || 'storage.bunnycdn.com',
    pullHostname: process.env.BUNNY_PULL_HOSTNAME,
  };
  if (!opts.dryRun) {
    for (const k of ['storageZone', 'storagePassword', 'pullHostname']) {
      if (!cfg[k]) { console.error(`Missing env: ${k}`); process.exit(1); }
    }
  }

  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  let rows;
  try {
    [rows] = await conn.execute(
      `SELECT id, slug, video_url, video_cdn_path, thumbnail_path
         FROM exercises
        WHERE active = 1 AND (video_url IS NOT NULL OR video_cdn_path IS NOT NULL)
        ORDER BY id`,
    );
  } catch (e) {
    await conn.end();
    console.error('DB query failed:', e.message);
    process.exit(1);
  }

  let targets = rows
    .filter((r) => (opts.only ? r.slug.includes(opts.only) : true))
    .slice(0, opts.limit);

  const workDir = opts.workDir || path.resolve(__dirname, '..', '.tmp_transcode', 'thumbs');
  await fsp.mkdir(workDir, { recursive: true });

  console.log(`Exercises with video: ${rows.length}  |  targets: ${targets.length}`);
  console.log(`New CDN prefix: ${opts.prefix}/  |  width ${opts.width}px  |  Mode: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}  |  --db ${opts.db}`);

  if (opts.dryRun) {
    for (const r of targets) {
      const src = r.video_url || `https://${cfg.pullHostname}/${r.video_cdn_path}`;
      console.log(`  ${r.slug.padEnd(34)} → ${opts.prefix}/${r.slug}.jpg   (from ${src.replace('https://homifit.b-cdn.net/', '')})`);
    }
    console.log(`\nDRY-RUN: ${targets.length} thumbnail(s) would be regenerated + uploaded${opts.db ? ' + thumbnail_path set' : ''}.`);
    await conn.end();
    return;
  }

  const ok = []; const failed = [];
  const queue = targets.slice();
  let done = 0;

  async function processOne(r, wid) {
    const cdnPath = `${opts.prefix}/${r.slug}.jpg`;
    const url = `https://${cfg.pullHostname}/${encodePath(cdnPath)}`;
    const tmp = path.join(workDir, `w${wid}-${r.slug}.jpg`);
    const src = r.video_url || `https://${cfg.pullHostname}/${encodePath(r.video_cdn_path)}`;
    try {
      if (!opts.force) {
        const h = await head(url);
        if (h.status === 200 && h.len > 1000) {
          ok.push({ ...r, cdnPath, url, skipped: true });
          console.log(`SKIP [${++done}/${targets.length}] ${cdnPath} (exists)`);
          return;
        }
      }
      const ff = await extractFrame(src, tmp, opts.width);
      if (ff.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
        throw new Error(`ffmpeg frame extract failed (code ${ff.code}): ${ff.stderr.slice(0, 140)}`);
      }
      const dim = jpegSize(tmp);
      await bunnyPut(cfg, cdnPath, tmp, 'image/jpeg');
      ok.push({ ...r, cdnPath, url, bytes: fs.statSync(tmp).size, dim });
      console.log(`OK   [${++done}/${targets.length}] ${cdnPath}  ${mb(fs.statSync(tmp).size)}MB  ${dim ? dim.width + 'x' + dim.height : '?'}`);
    } catch (err) {
      failed.push({ slug: r.slug, error: err.message });
      console.error(`FAIL [${++done}/${targets.length}] ${r.slug} :: ${err.message}`);
    } finally {
      try { await fsp.rm(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
  }
  async function worker(id) { while (queue.length) { const r = queue.shift(); if (r) await processOne(r, id); } }
  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1)));

  console.log(`\n--- summary ---\nuploaded/ok=${ok.length} failed=${failed.length}`);
  if (failed.length) failed.forEach((f) => console.log(`  ${f.slug} :: ${f.error}`));

  if (opts.db) {
    let affected = 0;
    for (const r of ok) {
      const [res] = await conn.execute(
        'UPDATE exercises SET thumbnail_path = ? WHERE id = ?',
        [r.cdnPath, r.id],
      );
      affected += res.affectedRows || 0;
    }
    console.log(`DB: thumbnail_path set on ${affected} exercise row(s) → ${opts.prefix}/<slug>.jpg`);
  }

  await conn.end();
  if (failed.length) process.exitCode = 2;
}

main().catch((err) => { console.error(err); process.exit(1); });
