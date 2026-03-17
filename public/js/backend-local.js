/**
 * backend-local.js
 *
 * Local backend for the video editor.  All processing runs in-browser via
 * FFmpeg.wasm — no uploads, no server calls, no auth required.
 *
 * FFmpeg.wasm and its utilities are loaded from unpkg CDN at runtime and
 * cached in-module so they are only fetched once.  WASM binaries are fetched
 * via toBlobURL() which converts them to same-origin blob: URLs, satisfying
 * the COEP: require-corp policy injected by coi-serviceworker.js.
 *
 * Multi-threading: when SharedArrayBuffer is available (crossOriginIsolated is
 * true) we load @ffmpeg/core-mt; otherwise we fall back to @ffmpeg/core (ST).
 *
 * Progress is reported on a per-exec-command basis, weighted so that each
 * trim pass contributes an equal share and the final concat+transcode pass
 * contributes the remaining share.
 */

// ─── CDN imports (pinned versions) ──────────────────────────────────────────

const FFMPEG_VERSION  = '0.12.10';
const UTIL_VERSION    = '0.12.1';
const CORE_VERSION    = '0.12.6';

const UNPKG = 'https://unpkg.com';
const FFMPEG_ESM = `${UNPKG}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`;
const UTIL_ESM   = `${UNPKG}/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`;

const CORE_BASE    = `${UNPKG}/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_MT_BASE = `${UNPKG}/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm`;

// The FFmpeg class worker is self-hosted so it runs from the page's origin.
// When loaded from a blob URL, the worker's relative imports (./const.js,
// ./errors.js) fail silently because blob: has an opaque origin — and
// import(blobCoreURL) inside a blob-origin module worker never resolves
// in some browsers.  Serving from the same origin avoids all of this.
const CLASS_WORKER_PATH = 'js/vendor/ffmpeg-worker.js';

// ─── Lazy module cache ───────────────────────────────────────────────────────

let _ffmpegMod = null;
let _utilMod   = null;

async function loadModules() {
  if (!_ffmpegMod || !_utilMod) {
    [_ffmpegMod, _utilMod] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_ESM),
      import(/* @vite-ignore */ UTIL_ESM),
    ]);
  }
  return { FFmpeg: _ffmpegMod.FFmpeg, fetchFile: _utilMod.fetchFile, toBlobURL: _utilMod.toBlobURL };
}

// ─── Backend class ───────────────────────────────────────────────────────────

export class LocalBackend {
  constructor() {
    this.mode      = 'local';
    this.ffmpeg    = null;   // FFmpeg instance, created once then reused
    this.loaded    = false;  // true after ffmpeg.load() completes
    this.onLog     = null;   // optional (msg: string) => void callback for raw FFmpeg log lines
    this._fontData = null;   // cached font Uint8Array for drawtext overlays
  }

  /**
   * Local mode has no remote library — clips are added via the file picker.
   * @returns {Promise<[]>}
   */
  async listVideos() {
    return [];
  }

  /**\n   * Generate a preview URL for a local File or Blob.\n   * @param {{ key: string, _file?: File|Blob }} file\n   * @returns {string}\n   */
  getPreviewUrl(file) {
    if (file._file instanceof Blob) {
      return URL.createObjectURL(file._file);
    }
    return '';
  }

  /**
   * Initialize FFmpeg.wasm.  Called automatically on first execute().
   * Safe to call again after a terminate() — it reinitialises cleanly.
   */
  async init() {
    this.onLog?.('Loading FFmpeg modules…');
    const { FFmpeg, toBlobURL } = await loadModules();

    this.ffmpeg = new FFmpeg();

    this.ffmpeg.on('log', ({ message }) => {
      this.onLog?.(message);
    });

    // The FFmpeg class worker must be same-origin.  We self-host the 5 KB
    // worker.js + its two tiny dependency modules in public/js/vendor/.
    const classWorkerURL = new URL(CLASS_WORKER_PATH, location.href).href;

    if (crossOriginIsolated) {
      // Fetch core JS as text and patch the compile-time PTHREAD_POOL_SIZE.
      // @ffmpeg/core-mt was compiled with PTHREAD_POOL_SIZE=0 (on-demand only).
      // On-demand pthread creation requires the event loop, but exec() blocks it
      // — deadlocking any codec that calls pthread_create().  Patching the JS to
      // pre-allocate a pool before exec() runs eliminates the deadlock.
      const poolSize = (navigator.hardwareConcurrency ?? 4) + 4;
      const coreText = await fetch(`${CORE_MT_BASE}/ffmpeg-core.js`).then(r => r.text());
      const patched  = coreText.replace(
        /PTHREAD_POOL_SIZE\s*=\s*\d+/,
        `PTHREAD_POOL_SIZE=${poolSize}`,
      );
      const coreURL   = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
      const wasmURL   = await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.wasm`,      'application/wasm');
      const workerURL = await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.worker.js`, 'text/javascript');
      this.onLog?.(`Loading multi-threaded core (pool = ${poolSize})…`);
      await this.ffmpeg.load({ classWorkerURL, coreURL, wasmURL, workerURL });
    } else {
      const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`,   'text/javascript');
      const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm');
      this.onLog?.('Loading single-threaded core…');
      await this.ffmpeg.load({ classWorkerURL, coreURL, wasmURL });
    }

    this.onLog?.('FFmpeg loaded');
    this.loaded = true;
  }

  /**
   * Process the edit job entirely in-browser using FFmpeg.wasm.
   *
   * The job is translated to FFmpeg command arrays by buildFFmpegArgs() using
   * preset 'medium' (trades a small quality reduction for practical run times
   * in-browser; the Actions workflow uses 'slow').
   *
   * @param {import('./ffmpeg-args.js').EditJob} job
   * @param {(ratio: number, step?: string) => void} [onProgress]  - called with 0..1 and optional step label
   * @returns {Promise<Blob>}  the finished MP4 as a Blob
   */
  async execute(job, onProgress) {
    if (!this.loaded) {
      this.onLog?.('Initialising FFmpeg…');
      await this.init();
    }

    const { fetchFile } = await loadModules();
    const { buildFFmpegArgs } = await import('./ffmpeg-args.js');

    // Pre-load font for drawtext overlays (FFmpeg.wasm has no system fonts).
    const hasOverlays = job.overlays && job.overlays.length > 0;
    if (hasOverlays && !this._fontData) {
      const fontUrl = new URL('js/vendor/font.ttf', location.href).href;
      this._fontData = await fetchFile(fontUrl);
    }

    const args = buildFFmpegArgs(job, {
      preset: 'medium',
      fontFile: hasOverlays ? 'font.ttf' : undefined,
    });
    this.onLog?.('[job] ' + args.trimCommands.length + ' clip(s) • ffmpeg ' + args.finalCommand.join(' '));
    const totalSteps  = args.trimCommands.length + 1;
    let   stepsDone   = 0;

    // Attach progress listener — fired by FFmpeg.wasm during each exec().
    const onFFmpegProgress = ({ progress, time }) => {
      if (typeof onProgress === 'function') {
        // FFmpeg.wasm reports `progress` as 0..1 when duration is known.
        // When it's unknown (or negative), fall back to a slow log curve
        // based on elapsed time so the bar still moves.
        let pct = progress;
        if (!pct || pct < 0) {
          // time is in microseconds; map to a curve that approaches 0.9
          const secs = Math.max(0, (time || 0)) / 1_000_000;
          pct = 1 - 1 / (1 + secs / 15);
        }
        const overall = (stepsDone + Math.min(1, Math.max(0, pct))) / totalSteps;
        onProgress(Math.min(0.99, overall));
      }
    };
    this.ffmpeg.on('progress', onFFmpegProgress);

    const writtenFiles = [];

    try {
      // 1. Write font to VFS if needed for text overlays.
      if (hasOverlays) {
        await this.ffmpeg.writeFile('font.ttf', this._fontData);
        writtenFiles.push('font.ttf');
      }

      // 2. Write each source clip into the FFmpeg virtual FS.
      for (const [i, clip] of job.clips.entries()) {
        onProgress?.(stepsDone / totalSteps, `Loading clip ${i + 1}/${job.clips.length}…`);
        const name = `clip_${i}.mp4`;
        await this.ffmpeg.writeFile(name, await fetchFile(clip._file));
        writtenFiles.push(name);
      }

      // 3. Trim each clip to its in/out range.
      for (const [i, trimCmd] of args.trimCommands.entries()) {
        onProgress?.(stepsDone / totalSteps, `Trimming clip ${i + 1}/${args.trimCommands.length}…`);
        await this._exec(trimCmd);
        stepsDone++;
        writtenFiles.push(trimCmd[trimCmd.length - 1]);
      }

      // 4. Write the concat manifest.
      await this.ffmpeg.writeFile('concat_list.txt', args.concatList);
      writtenFiles.push('concat_list.txt');

      // 5. Final concat + transcode.
      onProgress?.(stepsDone / totalSteps, 'Encoding final output…');
      await this._exec(args.finalCommand);
      writtenFiles.push('output.mp4');

      // 6. Read the output back as a Blob.
      const data = await this.ffmpeg.readFile('output.mp4');
      onProgress?.(1, 'Done');
      return new Blob([data], { type: 'video/mp4' });

    } finally {
      this.ffmpeg.off('progress', onFFmpegProgress);
      await this._cleanup(writtenFiles);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Run a single FFmpeg exec and throw a descriptive error on non-zero exit.
   * @param {string[]} cmd
   */
  async _exec(cmd) {
    const ret = await this.ffmpeg.exec(cmd);
    if (ret !== 0) {
      throw new Error(`FFmpeg exited with code ${ret}. Command: ${cmd.join(' ')}`);
    }
  }

  /**
   * Delete virtual FS files, ignoring errors for files that weren't created.
   * @param {string[]} names
   */
  async _cleanup(names) {
    for (const name of names) {
      try { await this.ffmpeg.deleteFile(name); } catch { /* ignore */ }
    }
  }

  /** @returns {boolean} */
  canProcessLocally() {
    return typeof crossOriginIsolated !== 'undefined';
  }

  /**
   * Compress a raw file to H.264+AAC MP4 (720p, crf 30, 64 kbps audio).
   * Called when files are dropped into the local library so subsequent
   * trim/export works on much smaller files.
   *
   * @param {File} file
   * @param {(ratio: number) => void} [onProgress] - called with 0..1
   * @returns {Promise<{blob: Blob, duration: number}>}
   */
  async importFile(file, onProgress) {
    if (!this.loaded) await this.init();
    const { fetchFile } = await loadModules();

    const inName  = 'import_in.mp4';
    const outName = 'import_out.mp4';

    const onFFmpegProgress = ({ progress, time }) => {
      if (typeof onProgress !== 'function') return;
      let pct = progress;
      if (!pct || pct < 0) {
        const secs = Math.max(0, (time || 0)) / 1_000_000;
        pct = 1 - 1 / (1 + secs / 15);
      }
      onProgress(Math.min(0.99, Math.max(0, pct)));
    };
    this.ffmpeg.on('progress', onFFmpegProgress);

    try {
      await this.ffmpeg.writeFile(inName, await fetchFile(file));
      await this._exec([
        '-i', inName,
        '-c:v', 'libx264', '-crf', '30', '-preset', 'ultrafast',
        '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
        '-r', '24',
        '-c:a', 'aac', '-b:a', '64k',
        '-movflags', '+faststart',
        '-y', outName,
      ]);
      const data = await this.ffmpeg.readFile(outName);
      const blob = new Blob([data], { type: 'video/mp4' });

      // Probe duration from the blob
      const duration = await new Promise(resolve => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        const url = URL.createObjectURL(blob);
        v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Math.round(v.duration * 100) / 100); };
        v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
        v.src = url;
      });

      onProgress?.(1);
      return { blob, duration };
    } finally {
      this.ffmpeg.off('progress', onFFmpegProgress);
      await this._cleanup([inName, outName]);
    }
  }

  /** @returns {{ maxResolution: string, showUploadWarning: boolean }} */
  getConfig() {
    return { maxResolution: '720p', showUploadWarning: false };
  }
}
