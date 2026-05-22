/**
 * Extract a JPG thumbnail (first ~0.8s frame) from each exercise video on
 * BunnyCDN and save it to `homifit/assets/images/exercise_thumbs/<slug>.jpg`.
 *
 * Why: in the workout-detail UI we used to render a single placeholder for
 * every exercise (or a per-muscle-group icon, which still looked repetitive
 * inside a single-muscle workout). Real video poster frames give each row
 * a distinct, instantly-recognizable thumbnail.
 *
 * Strategy:
 *   1. Read `slug` + `video_url` for every active exercise.
 *   2. For each, try the URL with `.mp4` / `.mov` extensions (the DB has
 *      mixed/truncated extensions — we sniff the right one by trying both).
 *   3. ffmpeg seeks to ~0.8s and writes a 240px-wide JPG.
 *   4. Skip already-extracted slugs (`--force` to redo all).
 *
 * Requires `ffmpeg.exe` on PATH or at the winget Gyan.FFmpeg install path.
 */

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pool } = require('../src/config/db');

const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'C:\\Users\\mrats\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe',
];
const OUT_DIR = path.resolve(__dirname, '..', '..', 'homifit', 'assets', 'images', 'exercise_thumbs');
const FORCE = process.argv.includes('--force');

function pickFfmpeg() {
  // Prefer concrete paths (winget install) over PATH because the just-
  // installed binary isn't on PATH until the shell restarts.
  for (const c of FFMPEG_CANDIDATES) {
    if (c !== 'ffmpeg' && fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

function runFfmpeg(ffmpeg, url, outPath) {
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-ss', '00:00:00.8',
      '-i', url,
      '-frames:v', '1',
      '-vf', 'scale=240:-1',
      '-q:v', '3',
      '-loglevel', 'error',
      outPath,
    ];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stderr: String(err) }));
  });
}

async function tryExtractWithFallbacks(ffmpeg, baseUrl, outPath) {
  // The DB has mixed/truncated extensions. Build a list of URL variants
  // to try in order, then return whichever produces a non-empty JPG.
  const variants = new Set();
  if (baseUrl.endsWith('.mp4') || baseUrl.endsWith('.mov')) {
    variants.add(baseUrl);
    variants.add(baseUrl.replace(/\.(mp4|mov)$/, '.MOV'));
    variants.add(baseUrl.replace(/\.(mp4|mov)$/, '.MP4'));
  }
  // Truncated `.mo` → try .mov / .mp4
  if (baseUrl.endsWith('.mo')) {
    const stem = baseUrl.slice(0, -3);
    ['.mov', '.mp4', '.MOV', '.MP4'].forEach((e) => variants.add(stem + e));
  }
  // No extension → try common ones
  if (!/\.[a-zA-Z0-9]{2,4}$/.test(baseUrl)) {
    ['.mp4', '.mov', '.MOV', '.MP4'].forEach((e) => variants.add(baseUrl + e));
  }
  // Always also try the base URL as-is
  variants.add(baseUrl);

  for (const url of variants) {
    const r = await runFfmpeg(ffmpeg, url, outPath);
    if (r.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      return { ok: true, url };
    }
  }
  return { ok: false };
}

(async () => {
  const ffmpeg = pickFfmpeg();
  console.log('ffmpeg:', ffmpeg);
  console.log('output dir:', OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const [rows] = await pool.execute(
    "SELECT slug, video_url, video_cdn_path FROM exercises " +
    "WHERE active = 1 AND (video_url IS NOT NULL OR video_cdn_path IS NOT NULL) " +
    "ORDER BY id",
  );
  console.log('exercises with videos:', rows.length);

  let ok = 0;
  let skip = 0;
  let fail = 0;
  const failed = [];

  for (const r of rows) {
    const out = path.join(OUT_DIR, `${r.slug}.jpg`);
    if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1000) {
      skip++;
      continue;
    }
    const url = r.video_url ||
      `https://homifit.b-cdn.net/${r.video_cdn_path}`.replace(/\/+/g, '/').replace(':/', '://');
    process.stdout.write(`  ${r.slug.padEnd(45)} `);
    const res = await tryExtractWithFallbacks(ffmpeg, url, out);
    if (res.ok) {
      ok++;
      console.log('OK', `(${path.basename(res.url)})`);
    } else {
      fail++;
      failed.push(r.slug);
      console.log('FAIL');
    }
  }

  console.log('');
  console.log(`done: ok=${ok} skipped=${skip} failed=${fail}`);
  if (failed.length) {
    console.log('failed slugs:', failed.join(', '));
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
