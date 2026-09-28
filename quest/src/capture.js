// Camera + mic capture -> contract messages.
//
// On Quest 3S the passthrough cameras show up as getUserMedia video devices in
// Quest Browser (needs a recent Horizon OS, see README). On a laptop this is just
// the webcam. Frames are grabbed on a timer (not rAF) because window rAF stops
// firing while an immersive XR session is running.

export async function listCameras() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'videoinput');
}

// Pick the most "world facing" camera. Quest labels are not documented, so we
// score by keywords and let ?cam=<substring> or the dropdown override.
export function pickCamera(cams, hint = '') {
  if (!cams.length) return null;
  if (hint) {
    const h = cams.find((c) => c.label.toLowerCase().includes(hint.toLowerCase()));
    if (h) return h;
  }
  const score = (l) => {
    l = l.toLowerCase();
    let s = 0;
    if (/passthrough|headset|left|right|back|rear|environment|world/.test(l)) s += 2;
    if (/left/.test(l)) s += 1; // left camera sits near the left eye, fine for anchoring
    if (/front|avatar|selfie|user|facetime/.test(l)) s -= 3;
    return s;
  };
  return [...cams].sort((a, b) => score(b.label) - score(a.label))[0];
}

export async function openCamera(deviceId) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } }
    : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export async function openMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }, // keep the person across from the wearer: suppression treats them as noise
    video: false,
  });
}

// ---- frames ---------------------------------------------------------------

export class FrameGrabber {
  constructor({ stream, videoEl, fps, width, quality, onFrame }) {
    this.stream = stream;
    this.videoEl = videoEl;
    this.fps = fps;
    this.width = width;
    this.quality = quality;
    this.onFrame = onFrame;
    this.count = 0;
    this.rate = 0;
    this._busy = false;
    this._timer = null;
    this._reader = null;
    this._latest = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this._useProcessor = 'MediaStreamTrackProcessor' in window;
  }

  start() {
    const track = this.stream.getVideoTracks()[0];
    // MediaStreamTrackProcessor keeps delivering frames even when the <video>
    // element is not being composited (e.g. during an XR session).
    if (this._useProcessor) {
      try {
        const proc = new window.MediaStreamTrackProcessor({ track });
        this._reader = proc.readable.getReader();
        this._pump();
      } catch {
        this._useProcessor = false;
      }
    }
    this._timer = setInterval(() => this._tick(), 1000 / this.fps);
    this._rateT = performance.now();
    this._rateN = 0;
  }

  async _pump() {
    while (this._reader) {
      const { value, done } = await this._reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (this._latest) this._latest.close();
      this._latest = value;
      this._latestAt = performance.now();
    }
  }

  // Local full-rate pixels for XR refraction; independent of JPEG/network fps.
  getCameraFrame() {
    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live" || track.muted) return null;
    if (this._useProcessor && this._latest) {
      return {
        source: this._latest,
        cameraLabel: track.label,
        width: this._latest.displayWidth,
        height: this._latest.displayHeight,
        time: this._latestAt,
      };
    }
    const video = this.videoEl;
    if (!video || video.readyState < 2 || video.paused) return null;
    if (this._videoTime !== video.currentTime) {
      this._videoTime = video.currentTime;
      this._videoAt = performance.now();
    }
    return {
      source: video,
      cameraLabel: track.label,
      width: video.videoWidth,
      height: video.videoHeight,
      time: this._videoAt,
    };
  }

  async _tick() {
    if (this._busy) return;
    let src, sw, sh;
    if (this._useProcessor && this._latest) {
      src = this._latest;
      sw = src.displayWidth;
      sh = src.displayHeight;
    } else if (this.videoEl && this.videoEl.readyState >= 2) {
      src = this.videoEl;
      sw = src.videoWidth;
      sh = src.videoHeight;
    } else return;
    if (!sw || !sh) return;

    this._busy = true;
    try {
      const w = Math.min(this.width, sw);
      const h = Math.round((sh / sw) * w);
      if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
      this.ctx.drawImage(src, 0, 0, w, h);
      const ts = Date.now() / 1000;
      const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', this.quality));
      if (!blob) return;
      const b64 = await blobToB64(blob);
      this.count++;
      this._rateN++;
      const now = performance.now();
      if (now - this._rateT > 2000) {
        this.rate = (this._rateN * 1000) / (now - this._rateT);
        this._rateT = now;
        this._rateN = 0;
      }
      this.onFrame({ ts, jpeg_b64: b64, w, h });
    } finally {
      this._busy = false;
    }
  }

  stop() {
    clearInterval(this._timer);
    if (this._reader) { this._reader.cancel().catch(() => {}); this._reader = null; }
    if (this._latest) { this._latest.close(); this._latest = null; }
  }
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---- audio: mic -> 16 kHz mono PCM16 chunks ---------------------------------


export class MicStreamer {
  constructor({ stream, chunkMs, onChunk, ctx }) {
    this.stream = stream;
    this.ctx = ctx; // pass one created inside the click handler (autoplay policy)
    this.chunkMs = chunkMs;
    this.onChunk = onChunk;
    this.chunks = 0;
    this.level = 0;
  }

  async start() {
    this.ctx = this.ctx || new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const emit = (buf) => {
      const pcm = new Int16Array(buf);
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
      this.level = peak / 32768;
      this.chunks++;
      this.onChunk({ ts: Date.now() / 1000, pcm16_b64: bytesToB64(new Uint8Array(buf)), sample_rate: 16000 });
    };
    try {
      await withTimeout(this.ctx.audioWorklet.addModule('/pcm16-worklet.js'), 3000);
      this.node = new AudioWorkletNode(this.ctx, 'pcm16', { processorOptions: { chunkMs: this.chunkMs } });
      this.node.port.onmessage = (e) => emit(e.data);
    } catch {
      this.node = scriptProcessorFallback(this.ctx, this.chunkMs, emit);
    }
    src.connect(this.node);
    // Node must be pulled by the graph; route through a muted gain.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  stop() { this.ctx && this.ctx.close(); }
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Deprecated but universally available; used only if the worklet fails to load.
function scriptProcessorFallback(ctx, chunkMs, emit) {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const ratio = ctx.sampleRate / 16000;
  const chunk = Math.round((16000 * chunkMs) / 1000);
  let buf = new Int16Array(chunk), n = 0, pos = 0, acc = 0, accN = 0;
  node.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      acc += ch[i]; accN++; pos += 1;
      if (pos >= ratio) {
        pos -= ratio;
        const v = Math.max(-1, Math.min(1, acc / accN));
        acc = 0; accN = 0;
        buf[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (n === chunk) { emit(buf.buffer); buf = new Int16Array(chunk); n = 0; }
      }
    }
  };
  return node;
}
