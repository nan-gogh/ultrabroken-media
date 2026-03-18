/**
 * ffmpeg-args.js
 *
 * Builds the FFmpeg command arrays for a trim+concat+transcode edit job.
 * This is the single source of truth for FFmpeg arguments used by:
 *   - backend-local.js  (executes them via FFmpeg.wasm in the browser)
 *   - backend-remote.js (sends the built vf filter chain to the Worker,
 *                        which passes it to edit.yml — no duplicate logic)
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
 * @property {string}     vf            - the complete -vf filter chain string
 */

/**
 * @typedef {Object} BuildOpts
 * @property {'ultrafast'|'superfast'|'veryfast'|'faster'|'fast'|'medium'|'slow'} [preset='slow']
 *   x264 preset for the final concat+transcode pass. The Actions workflow uses
 *   'slow' for maximum quality. Local (browser) mode defaults to 'medium' to
 *   keep processing time tolerable while still producing good output.
 * @property {string} [fontFile]
 *   Path to a font file in the FFmpeg virtual FS (or working directory for
 *   remote).  Used in drawtext's fontfile= option.  FFmpeg.wasm has no
 *   system fonts, so this is required for overlay text.
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

    const args = [];
    if (clip.start > 0) {
      args.push('-ss', String(clip.start));
    }
    args.push('-i', inputFile);
    if (clip.end !== -1) {
      const duration = clip.end - clip.start;
      args.push('-t', String(Math.round(duration * 1000) / 1000));
    }
    // Lossless intermediate: ultrafast encode, PCM audio — fast and lossless enough for trimming.
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0');
    args.push('-c:a', 'pcm_s16le');
    args.push('-y', outputFile);

    trimCommands.push(args);
    concatEntries.push(`file '${outputFile}'`);
  }

  // ── Build video filter chain ────────────────────────────────────────────
  let vf = "setpts=PTS-STARTPTS,scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease";

  if (job.overlays && job.overlays.length > 0) {
    const valid = job.overlays.filter(ov => ov.text.trim());
    if (valid.length) {
      const fontSize   = 36;
      const boxBorderW = 8;
      const marginB    = 32;

      // Collect all unique boundary times
      const times = new Set();
      for (const ov of valid) { times.add(ov.start); times.add(ov.end); }
      const boundaries = [...times].sort((a, b) => a - b);

      for (let i = 0; i < boundaries.length - 1; i++) {
        const segStart = boundaries[i];
        const segEnd   = boundaries[i + 1];
        const active = valid.filter(ov => ov.start <= segStart && ov.end >= segEnd);
        if (!active.length) continue;

        const n = active.length;
        for (let li = 0; li < n; li++) {
          const safeText = active[li].text.trim()
            .replace(/\\/g, '\\\\\\\\')
            .replace(/'/g, '\u2019')
            .replace(/:/g, '\\\\:')
            .replace(/%/g, '%%%%');
          // Stack bottom-to-top using th (actual rendered text height).
          // boxborderw=8 ensures backdrops overlap to close any gap.
          const revIdx = n - 1 - li;
          const yExpr = `h-${marginB}-(${revIdx + 1})*th-(${2 * revIdx + 1})*${boxBorderW}`;
          vf += `,drawtext=text='${safeText}'`
            + `:enable='between(t,${segStart},${segEnd})'`
            + `:fontsize=${fontSize}:fontcolor=0x00f0c2`
            + `:box=1:boxcolor=0x1e1f29:boxborderw=${boxBorderW}`
            + (opts.fontFile ? `:fontfile=${opts.fontFile}` : '')
            + `:x=(w-tw)/2:y=${yExpr}`;
        }
      }
    }
  }

  const finalCommand = [
    '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt',
    '-c:v', 'libx264', '-crf', '30', '-preset', preset,
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
    vf,
  };
}
