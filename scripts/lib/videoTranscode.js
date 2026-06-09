/**
 * Shared video-transcode helpers used by the CDN upload pipeline.
 *
 * Why this exists: the exercise demo clips were uploaded as raw QuickTime
 * `.mov` files (Content-Type: video/quicktime) with the `moov` index atom at
 * the *end* of the file. ExoPlayer (Flutter video_player on Android) has to
 * read `moov` before it can render the first frame, so a tail `moov` forces it
 * to seek/download to the end first — which stalls or times out on mobile.
 * On top of that the encodes were wildly inconsistent (one clip was ~683MB).
 *
 * The fix is to re-encode every clip to a web-friendly H.264 MP4 with the
 * `moov` atom moved to the front (`-movflags +faststart`) and a sane size:
 *
 *   ffmpeg -i in.mov -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 24 \
 *     -preset veryfast -vf "scale='min(720,iw)':-2" -an -movflags +faststart out.mp4
 *
 * These are muted loop clips, so `-an` drops audio by default.
 *
 * This module wraps the ffmpeg/ffprobe invocations and a tiny MP4 box scanner
 * so callers can both produce and *verify* faststart output.
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Default re-encode parameters (overridable per call / via CLI flags).
const DEFAULTS = {
  maxWidth: 720, // cap the LONGER edge (portrait or landscape), keep aspect
  crf: 24, // x264 quality (lower = better/larger). 24 ≈ 1–5MB for these clips.
  preset: 'veryfast',
  keepAudio: false, // muted loop clips -> drop audio
  // Peak-bitrate cap. CRF alone leaves size unbounded for high-motion/long/
  // high-res clips (that's why a handful re-encoded to 30–300MB). Capping
  // maxrate hard-bounds the bitrate so even a busy clip stays a few MB.
  maxrate: '2500k',
  bufsize: '5000k',
  // A re-encoded clip larger than this is treated as suspicious (still works,
  // but the caller may want to flag it). 12MB is generous for a 720p loop.
  maxSizeBytes: 12 * 1024 * 1024,
};

// ffmpeg/ffprobe resolution. Prefer an explicit env override, then the bare
// name on PATH, then the winget install location (mirrors the convention in
// extractExerciseThumbnails.js so both scripts agree on where ffmpeg lives).
const WINGET_FFMPEG_DIR =
  'C:\\Users\\mrats\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin';

function resolveBinary(envVar, name) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // Bare name works whenever ffmpeg is on PATH (the common case now).
  // Fall back to the concrete winget path only if it exists on disk.
  const winget = `${WINGET_FFMPEG_DIR}\\${name}.exe`;
  if (fs.existsSync(winget)) return winget;
  return name;
}

function ffmpegBin() {
  return resolveBinary('FFMPEG_PATH', 'ffmpeg');
}

function ffprobeBin() {
  return resolveBinary('FFPROBE_PATH', 'ffprobe');
}

function run(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

/**
 * Build the ffmpeg argument list for the faststart re-encode.
 */
function buildFfmpegArgs(input, output, opts = {}) {
  const { maxWidth, crf, preset, keepAudio, maxrate, bufsize } = {
    ...DEFAULTS,
    ...opts,
  };
  const args = [
    '-y',
    '-loglevel', 'error',
    '-i', input,
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-crf', String(crf),
    '-preset', preset,
    // Cap the LONGER edge to maxWidth for BOTH orientations (the old
    // width-only scale left tall/high-res portrait clips at full size, e.g.
    // archer-push-up). The other edge auto-scales to a divisible-by-2 value.
    '-vf',
    `scale='if(gt(iw,ih),min(${maxWidth},iw),-2)':'if(gt(iw,ih),-2,min(${maxWidth},ih))'`,
  ];
  // Hard-bound the peak bitrate so CRF can't balloon the file size.
  if (maxrate) {
    args.push('-maxrate', String(maxrate), '-bufsize', String(bufsize || maxrate));
  }
  if (keepAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', output);
  return args;
}

/**
 * Transcode `input` → `output` (mp4, faststart). Resolves `{ ok, code, stderr }`.
 */
async function transcode(input, output, opts = {}) {
  const args = buildFfmpegArgs(input, output, opts);
  const res = await run(ffmpegBin(), args);
  const ok =
    res.code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0;
  return { ok, code: res.code, stderr: res.stderr, args };
}

/**
 * Probe a media file. Returns null on failure, otherwise normalized metadata.
 */
async function probe(file) {
  const res = await run(ffprobeBin(), [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate',
    '-show_entries', 'stream=index,codec_name,codec_type,width,height',
    '-of', 'json',
    file,
  ]);
  if (res.code !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (_) {
    return null;
  }
  const streams = parsed.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const fmt = parsed.format || {};
  return {
    durationSec: fmt.duration ? Number(fmt.duration) : null,
    sizeBytes: fmt.size ? Number(fmt.size) : null,
    bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
    width: video ? video.width : null,
    height: video ? video.height : null,
    vcodec: video ? video.codec_name : null,
    hasAudio: Boolean(audio),
  };
}

/**
 * Scan the top-level box (atom) layout of an MP4/MOV file without loading it
 * into memory. Returns an ordered array of `{ type, size }`.
 */
function scanTopLevelAtoms(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const order = [];
    let pos = 0;
    const hdr = Buffer.alloc(16);
    // Cap iterations — we only care about the leading boxes (ftyp/moov/mdat).
    while (pos < stat.size && order.length < 32) {
      const n = fs.readSync(fd, hdr, 0, 16, pos);
      if (n < 8) break;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (size === 1) {
        // 64-bit "largesize" stored in the 8 bytes after the type.
        size = Number(hdr.readBigUInt64BE(8));
      } else if (size === 0) {
        // Box extends to EOF.
        size = stat.size - pos;
      }
      order.push({ type, size });
      if (size <= 0) break;
      pos += size;
    }
    return order;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * True when the `moov` atom precedes `mdat` at the top level (faststart).
 */
function isFastStart(file) {
  const atoms = scanTopLevelAtoms(file);
  const moov = atoms.findIndex((a) => a.type === 'moov');
  const mdat = atoms.findIndex((a) => a.type === 'mdat');
  return moov !== -1 && mdat !== -1 && moov < mdat;
}

/**
 * Verify a transcoded clip is web-ready: faststart, H.264, within size budget.
 * Returns `{ ok, faststart, sizeBytes, width, height, vcodec, problems[] }`.
 */
async function verify(file, opts = {}) {
  const { maxSizeBytes } = { ...DEFAULTS, ...opts };
  const problems = [];
  if (!fs.existsSync(file)) {
    return { ok: false, problems: ['file does not exist'] };
  }
  const sizeBytes = fs.statSync(file).size;
  const faststart = isFastStart(file);
  if (!faststart) problems.push('moov atom is not before mdat (no faststart)');

  const meta = await probe(file);
  if (!meta) {
    problems.push('ffprobe could not read the file (corrupt?)');
  } else {
    if (meta.vcodec !== 'h264') problems.push(`video codec is ${meta.vcodec}, expected h264`);
    if (sizeBytes > maxSizeBytes) {
      problems.push(
        `size ${(sizeBytes / 1048576).toFixed(1)}MB exceeds budget ${(maxSizeBytes / 1048576).toFixed(0)}MB`,
      );
    }
  }
  return {
    ok: faststart && problems.length === 0,
    faststart,
    sizeBytes,
    width: meta ? meta.width : null,
    height: meta ? meta.height : null,
    vcodec: meta ? meta.vcodec : null,
    durationSec: meta ? meta.durationSec : null,
    problems,
  };
}

module.exports = {
  DEFAULTS,
  ffmpegBin,
  ffprobeBin,
  buildFfmpegArgs,
  transcode,
  probe,
  scanTopLevelAtoms,
  isFastStart,
  verify,
};
