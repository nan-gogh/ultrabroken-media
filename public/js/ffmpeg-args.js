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
 * @property {string|null} assContent   - ASS subtitle file content (null when no overlays)
 */

/**
 * @typedef {Object} BuildOpts
 * @property {'ultrafast'|'superfast'|'veryfast'|'faster'|'fast'|'medium'|'slow'} [preset='slow']
 *   x264 preset for the final concat+transcode pass. The Actions workflow uses
 *   'slow' for maximum quality. Local (browser) mode defaults to 'medium' to
 *   keep processing time tolerable while still producing good output.
 * @property {string} [fontFile]
 *   When set, the ASS subtitle filter includes fontsdir=. so libass can find
 *   the font file in the FFmpeg virtual FS (which has no system fonts).
 *   Example: `'font.ttf'` (written to the VFS root before encode).
 * @property {string} [fontFamily='Arial']
 *   Font family name to use in the ASS style.  Must match the internal family
 *   name of the font at `fontFile` when running in FFmpeg.wasm (which has no
 *   system fonts).  Defaults to 'Arial' for remote/Actions where system fonts
 *   are available.
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

  let assContent = null;

  if (job.overlays && job.overlays.length > 0) {
    const valid = job.overlays.filter(ov => ov.text.trim());
    if (valid.length) {
      assContent = buildAssContent(valid, opts.fontFamily || 'Arial');
      vf += ',ass=subs.ass' + (opts.fontFile ? ':fontsdir=.' : '');
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
    assContent,
  };
}

// ── ASS subtitle helpers ──────────────────────────────────────────────────

/** Convert seconds to ASS time format (H:MM:SS.cc). */
function toAssTime(seconds) {
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Build an ASS subtitle file from overlay definitions.
 *
 * Uses BorderStyle=3 (opaque box) with 50% transparent black background,
 * centered white text (Alignment=2), and bottom margin matching the previous
 * drawtext layout.  Overlapping time ranges are merged into single Dialogue
 * lines joined with \N (hard line break) so they share one background box.
 *
 * @param {Overlay[]} overlays - non-empty, already filtered for blank text
 * @param {string} fontFamily - font family name for the ASS style
 * @returns {string} complete ASS file content
 */
function buildAssContent(overlays, fontFamily) {
  const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},36,&H00C2F000,&H000000FF,&H00000000,&H8017110F,0,0,0,0,100,100,0,0,3,3,0,2,10,10,32,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Split overlapping time ranges at boundary points so each segment
  // gets a single Dialogue line with all active text joined by \N.
  const times = new Set();
  for (const ov of overlays) { times.add(ov.start); times.add(ov.end); }
  const boundaries = [...times].sort((a, b) => a - b);

  const dialogues = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd   = boundaries[i + 1];
    const active = overlays.filter(ov => ov.start <= segStart && ov.end >= segEnd);
    if (!active.length) continue;

    const text = active.map(ov => ov.text.trim()).join('\\N');
    dialogues.push(
      `Dialogue: 0,${toAssTime(segStart)},${toAssTime(segEnd)},Default,,0,0,0,,${text}`
    );
  }

  return header + '\n' + dialogues.join('\n') + '\n';
}
