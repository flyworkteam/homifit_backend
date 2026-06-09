#!/usr/bin/env node
/**
 * Republish the re-encoded "oversized native .mp4" clips to fresh, uncached
 * URLs and repoint the manifest + DB to them.
 *
 * Context: transcodeCdnVideos.js --reencode-mp4-over re-encoded ~53 large
 * native .mp4 files IN PLACE (same path). The new small files landed on the
 * BunnyCDN Storage origin correctly, but those URLs were already cached at the
 * CDN edge, so the pull zone keeps serving the stale large copies. Purging the
 * edge needs an account API key we don't want to handle here, so instead we
 * publish each small file to a NEW path (`<name>-720.mp4`) that was never
 * cached — it serves fresh immediately — and move all references to it.
 *
 * The small re-encoded file already lives on the Storage origin at the old
 * path, so we just copy origin→new-path (download with AccessKey, re-upload);
 * no re-download of the huge original and no re-transcode.
 *
 * Usage:
 *   node scripts/republishResizedMp4.js [--dry-run] [--rewrite-manifest] [--db]
 *        [--report <path>] [--manifest <path>] [--suffix -720]
 *        [--concurrency N] [--force]
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
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
    dryRun: false, rewriteManifest: false, db: false, force: false,
    report: null, manifest: null, suffix: '-720', concurrency: 4,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--rewrite-manifest') o.rewriteManifest = true;
    else if (a === '--db') o.db = true;
    else if (a === '--force') o.force = true;
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--suffix') o.suffix = argv[++i];
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]) || 4;
  }
  return o;
}

const mb = (b) => (b / 1048576).toFixed(2);
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const newPathFor = (p, suffix) => p.replace(/\.mp4$/i, `${suffix}.mp4`);

function head(url) {
  return new Promise((r) => {
    https.request(url, { method: 'HEAD', timeout: 30000 }, (res) => {
      res.resume();
      r({ status: res.statusCode, len: +res.headers['content-length'] || 0, ct: res.headers['content-type'] });
    }).on('error', () => r({ status: 0 })).end();
  });
}

// Download an object from the Storage ORIGIN (authenticated; never cached).
function storageGet(cfg, objPath, dest) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', host: cfg.storageHostname, path: '/' + cfg.storageZone + '/' + encodePath(objPath), headers: { AccessKey: cfg.storagePassword } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`storage GET ${objPath} → ${res.statusCode}`)); }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(fs.statSync(dest).size)));
        out.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
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

async function main() {
  const opts = parseArgs(process.argv);
  const reportPath = opts.report || path.resolve(__dirname, '..', '.tmp_transcode', 'cdn', 'transcode-report.json');
  const manifestPath = opts.manifest || path.resolve(__dirname, '..', 'config', 'video-manifest.json');
  if (!fs.existsSync(reportPath)) { console.error(`Report not found: ${reportPath}`); process.exit(1); }

  const cfg = {
    storageZone: process.env.BUNNY_STORAGE_ZONE,
    storagePassword: process.env.BUNNY_STORAGE_PASSWORD,
    storageHostname: process.env.BUNNY_STORAGE_HOSTNAME || 'storage.bunnycdn.com',
    pullHostname: process.env.BUNNY_PULL_HOSTNAME,
  };
  for (const k of ['storageZone', 'storagePassword', 'pullHostname']) {
    if (!cfg[k]) { console.error(`Missing env: ${k}`); process.exit(1); }
  }

  // Select the in-place .mp4 re-encodes from the report: same src/target path,
  // succeeded, and the output is smaller than the source (i.e. we shrank it).
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const targets = report.filter(
    (r) => r.ok && !r.skipped && /\.mp4$/i.test(r.srcCdnPath) &&
      r.srcCdnPath === r.mp4CdnPath && r.outBytes && r.srcBytes && r.outBytes < r.srcBytes,
  ).map((r) => ({
    oldCdnPath: r.srcCdnPath,
    oldUrl: r.srcUrl,
    newCdnPath: newPathFor(r.srcCdnPath, opts.suffix),
    newUrl: `https://${cfg.pullHostname}/${encodePath(newPathFor(r.srcCdnPath, opts.suffix))}`,
    outBytes: r.outBytes,
  }));

  console.log(`Report: ${reportPath}`);
  console.log(`Targets (in-place re-encodes to republish): ${targets.length}`);
  console.log(`Suffix: ${opts.suffix}  |  Mode: ${opts.dryRun ? 'DRY-RUN' : 'LIVE'}  |  concurrency ${opts.concurrency}\n`);

  if (opts.dryRun) {
    for (const t of targets) console.log(`  ${t.oldCdnPath}  (origin ${mb(t.outBytes)}MB)  →  ${t.newCdnPath}`);
    console.log(`\nDRY-RUN: ${targets.length} clip(s) would be copied to new paths + references repointed.`);
    return;
  }

  const workDir = path.resolve(__dirname, '..', '.tmp_transcode', 'republish');
  await fsp.mkdir(workDir, { recursive: true });

  const ok = []; // { oldUrl, oldCdnPath, newUrl, newCdnPath }
  const failed = [];
  const queue = targets.slice();
  let done = 0;

  async function processOne(t, wid) {
    const tmp = path.join(workDir, `w${wid}-${t.newCdnPath.replace(/[^a-z0-9]+/gi, '_')}`);
    try {
      // Idempotency: a correct small twin already at the new URL → skip.
      if (!opts.force) {
        const h = await head(t.newUrl);
        if (h.status === 200 && h.len > 0 && h.len < 8 * 1048576) {
          ok.push(t);
          console.log(`SKIP [${++done}/${targets.length}] ${t.newCdnPath} (already published, ${mb(h.len)}MB)`);
          return;
        }
      }
      // Pull the (small, faststart) re-encoded file straight from the origin.
      const got = await storageGet(cfg, t.oldCdnPath, tmp);
      const v = await transcoder.verify(tmp);
      if (!v.faststart) throw new Error('origin copy is not faststart (unexpected)');
      if (got > 8 * 1048576) throw new Error(`origin copy still large (${mb(got)}MB) — re-encode may not have landed`);
      await bunnyPut(cfg, t.newCdnPath, tmp, 'video/mp4');
      ok.push(t);
      console.log(`OK   [${++done}/${targets.length}] ${t.newCdnPath}  ${mb(got)}MB  ${v.width}x${v.height} faststart`);
    } catch (err) {
      failed.push({ ...t, error: err.message });
      console.error(`FAIL [${++done}/${targets.length}] ${t.oldCdnPath} :: ${err.message}`);
    } finally {
      try { await fsp.rm(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
  }
  async function worker(id) { while (queue.length) { const t = queue.shift(); if (t) await processOne(t, id); } }
  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1)));

  console.log(`\n--- summary ---\nrepublished=${ok.length} failed=${failed.length}`);
  if (failed.length) failed.forEach((f) => console.log(`  ${f.oldCdnPath} :: ${f.error}`));

  // old URL → new URL/path map for repointing references.
  const map = new Map(ok.map((t) => [t.oldUrl, { url: t.newUrl, cdnPath: t.newCdnPath, oldCdnPath: t.oldCdnPath }]));

  if (opts.rewriteManifest) {
    fs.copyFileSync(manifestPath, `${manifestPath}.bak`);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let n = 0;
    for (const v of m.videos || []) {
      const hit = map.get(v.url);
      if (hit) { v.url = hit.url; v.cdnPath = hit.cdnPath; n++; }
    }
    for (const key of Object.keys(m.byBaseSlug || {})) {
      const val = m.byBaseSlug[key];
      const swap = (u) => (map.has(u) ? map.get(u).url : u);
      m.byBaseSlug[key] = Array.isArray(val) ? val.map(swap) : swap(val);
    }
    m.videos.sort((a, b) => a.cdnPath.localeCompare(b.cdnPath));
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
    console.log(`Manifest rewritten: ${n} entr${n === 1 ? 'y' : 'ies'} → ${opts.suffix}.mp4 (backup: ${path.basename(manifestPath)}.bak)`);
  }

  if (opts.db) {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    let affected = 0;
    try {
      for (const [oldUrl, info] of map) {
        const [res] = await conn.execute(
          'UPDATE exercises SET video_cdn_path = ?, video_url = ? WHERE video_cdn_path = ? OR video_url = ?',
          [info.cdnPath, info.url, info.oldCdnPath, oldUrl],
        );
        affected += res.affectedRows || 0;
      }
      console.log(`DB repoint: ${affected} exercise row(s) updated → ${opts.suffix}.mp4`);
    } finally { await conn.end(); }
  }

  if (failed.length) process.exitCode = 2;
}

main().catch((err) => { console.error(err); process.exit(1); });
