/**
 * ffmpeg-args.js
 *
 * Builds the FFmpeg command arrays for a trim+concat+transcode edit job.
 * This is the single source of truth for FFmpeg arguments shared between:
 *   - backend-local.js  (executes them via FFmpeg.wasm in the browser)
 *   - backend-remote.js (passes the job description to the Worker, which
 *                        dispatches edit.yml — the workflow mirrors this logic)
 *
 * Keep this in sync with .github/workflows/edit.yml.
 */

/**
 * @typedef {Object} Clip
 * @property {string} key         - R2 key (e.g. "video/foo.mp4") or local filename
 * @property {number} start       - trim start time in seconds
 * @property {number} end         - trim end time in seconds, or -1 for full length
 * @property {File|null} _file    - local File object (local mode only)
 */

/**
 * @typedef {Object} Overlay
 * @property {string} text   - display text
 * @property {number} start  - seconds into the output when overlay appears
 * @property {number} end    - seconds into the output when overlay disappears
 */

/**
 * @typedef {Object} EditJob
 * @property {Clip[]}    clips
 * @property {Overlay[]} overlays
 * @property {string}    outputKey
 * @property {boolean}   [force]
 */

/**
 * @typedef {Object} FFmpegArgs
 * @property {string[][]} trimCommands  - one arg array per clip (trim to intermediate MKV)
 * @property {string}     concatList    - contents of the ffconcat list file
 * @property {string[]}   finalCommand  - arg array for concat+transcode pass
 */

/**
 * @typedef {Object} BuildOpts
 * @property {'ultrafast'|'superfast'|'veryfast'|'faster'|'fast'|'medium'|'slow'} [preset='slow']
 *   x264 preset for the final concat+transcode pass. The Actions workflow uses
 *   'slow' for maximum quality. Local (browser) mode defaults to 'medium' to
 *   keep processing time tolerable while still producing good output.
 * @property {string} [fontFile]
 *   Path to a font file in the FFmpeg virtual FS to use for drawtext overlays.
 *   Required when running inside FFmpeg.wasm, which has no system fonts.
 *   Example: `'font.ttf'` (written to the VFS root before encode).
 */

/**
 * Build FFmpeg command arrays for the given job.
 * Clip input filenames are referenced as `clip_0.mp4`, `clip_1.mp4`, etc.,
 * matching how backend-local.js writes them to the FFmpeg.wasm virtual FS.
 *
 * @param {EditJob} job
 * @param {BuildOpts} [opts]
 * @returns {FFmpegArgs}
 */
export function buildFFmpegArgs(job, opts = {}) {
  const preset = opts.preset || 'slow';
  const trimCommands = [];
  const concatEntries = [];

  for (let i = 0; i < job.clips.length; i++) {
    const clip = job.clips[i];
    const inputFile = `clip_${i}.mp4`;
    const outputFile = `trimmed_${i}.mkv`;

    const args = ['-threads', '1'];
    if (clip.start > 0) {
      args.push('-ss', String(clip.start));
    }
    args.push('-i', inputFile);
    if (clip.end !== -1) {
      const duration = clip.end - clip.start;
      args.push('-t', String(Math.round(duration * 1000) / 1000));
    }
    // Lossless intermediate: ultrafast encode, PCM audio — fast and lossless enough for trimming.
    // x264-params threads=1: prevent libx264 from spawning more pthreads than the WASM pool allows.
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0');
    args.push('-x264-params', 'threads=1:lookahead_threads=0');
    args.push('-c:a', 'pcm_s16le');
    args.push('-y', outputFile);

    trimCommands.push(args);
    concatEntries.push(`file '${outputFile}'`);
  }

  // ── Build video filter chain ────────────────────────────────────────────
  let vf = "setpts=PTS-STARTPTS,scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease";

  if (job.overlays && job.overlays.length > 0) {
    for (const ov of job.overlays) {
      if (!ov.text.trim()) continue;
      // Escape special characters for ffmpeg drawtext filter
      const safeText = ov.text.trim()
        .replace(/\\/g, '\\\\\\\\')
        .replace(/'/g, '\u2019')        // typographic apostrophe avoids shell quoting issues
        .replace(/:/g, '\\\\:')
        .replace(/%/g, '%%%%');
      vf += `,drawtext=text='${safeText}'`
        + `:enable='between(t,${ov.start},${ov.end})'`
        + `:fontsize=36:fontcolor=white`
        + (opts.fontFile ? `:fontfile=${opts.fontFile}` : '')
        + `:x=(w-tw)/2:y=h-th-40`
        + `:box=1:boxcolor=black@0.5:boxborderw=8`;
    }
  }

  const finalCommand = [
    '-threads', '1',
    '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt',
    '-filter_threads', '1',
    '-c:v', 'libx264', '-crf', '30', '-preset', preset,
    '-x264-params', 'threads=1:lookahead_threads=0',
    '-vf', vf,
    '-af', 'asetpts=PTS-STARTPTS',
    '-r', '24',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart',
    '-y', 'output.mp4',
  ];

  return {
    trimCommands,
    concatList: concatEntries.join('\n'),
    finalCommand,
  };
}
