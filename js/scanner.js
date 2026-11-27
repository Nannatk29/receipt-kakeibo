// カメラ映像を連続で OCR し、ReceiptAccumulator に流し込むスキャナ。
import { flatten, toGray, sharpness } from './preprocess.js';
import { parseFrame, ReceiptAccumulator } from './parser.js';

const abs = (p) => new URL(p, document.baseURI).href;

// ガイド枠(画面に対する割合)。CSS の .guide と一致させる
export const GUIDE = { w: 0.88, h: 0.50, top: 0.14 };
const OCR_WIDTH = 960; // OCR に渡す画像の幅

let workerPromise = null;
/** Tesseract ワーカーを用意する(2回目以降は同じものを返す) */
export function prepareOCR(onProgress) {
  if (workerPromise) return workerPromise;
  let ready = false; // 準備が終わったら進捗は通知しない(認識中の進捗と混ざるため)
  workerPromise = (async () => {
    const T = window.Tesseract;
    if (!T) throw new Error('OCR エンジンを読み込めませんでした');
    const worker = await T.createWorker('jpn', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/core'),
      langPath: abs('vendor/tesseract/lang'),
      gzip: true,
      workerBlobURL: false, // 同一オリジンのワーカーにして Service Worker のキャッシュを効かせる
      logger: (m) => { if (!ready && onProgress) onProgress(m); },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    ready = true;
    return worker;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

export class LiveScanner {
  /**
   * @param {{video:HTMLVideoElement, overlay:HTMLCanvasElement, onUpdate:Function, onStatus:Function}} opts
   */
  constructor({ video, overlay, onUpdate, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.acc = new ReceiptAccumulator();
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.paused = false;
    this.stream = null;
    this.track = null;
    this.lastBoxes = [];
    this.boxTime = 0;
    this.sharpHistory = [];
    this.timings = [];
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // ブラウザが要求サイズに合わせて映像を切り抜くと、縦持ちで拡大されすぎるため無効にする
        resizeMode: { ideal: 'none' },
      },
    });
    this.track = this.stream.getVideoTracks()[0];
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* 未対応端末 */ }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this._drawLoop();
    this._ocrLoop();
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  reset() {
    this.acc.reset();
    this.lastBoxes = [];
    this.onUpdate(this.acc.snapshot());
  }

  get torchSupported() {
    const caps = this.track?.getCapabilities?.();
    return !!(caps && caps.torch);
  }

  async setTorch(on) {
    if (!this.track) return false;
    try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }

  /** 画面上のガイド枠を、映像の画素座標に変換する(object-fit: cover を考慮) */
  _guideRect() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const cw = v.clientWidth, ch = v.clientHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const offX = (cw - vw * scale) / 2, offY = (ch - vh * scale) / 2;
    const gx = cw * (1 - GUIDE.w) / 2, gy = ch * GUIDE.top, gw = cw * GUIDE.w, gh = ch * GUIDE.h;
    return {
      sx: (gx - offX) / scale, sy: (gy - offY) / scale, sw: gw / scale, sh: gh / scale,
      screen: { x: gx, y: gy, w: gw, h: gh },
    };
  }

  async _ocrLoop() {
    let worker;
    try {
      worker = await prepareOCR((m) => {
        if (m.status && m.progress != null) this.onStatus({ phase: 'loading', status: m.status, progress: m.progress });
      });
    } catch (e) {
      this.onStatus({ phase: 'error', message: e.message || String(e) });
      return;
    }
    this.onStatus({ phase: 'scanning' });
    while (this.running) {
      if (this.paused || !this.video.videoWidth || document.hidden) { await sleep(200); continue; }
      const g = this._guideRect();
      const scale = OCR_WIDTH / g.sw;
      const W = OCR_WIDTH, H = Math.round(g.sh * scale);
      this.canvas.width = W; this.canvas.height = H;
      this.ctx.drawImage(this.video, g.sx, g.sy, g.sw, g.sh, 0, 0, W, H);
      const frame = this.ctx.getImageData(0, 0, W, H);

      // 手ブレしたフレームは飛ばす(直近の鮮明さと比べて判断)
      const sharp = sharpness(toGray(frame), W, H, 3);
      this.sharpHistory.push(sharp);
      if (this.sharpHistory.length > 12) this.sharpHistory.shift();
      const ref = [...this.sharpHistory].sort((a, b) => b - a)[Math.floor(this.sharpHistory.length / 4)] || sharp;
      if (this.sharpHistory.length > 3 && sharp < ref * 0.45) {
        this.onStatus({ phase: 'scanning', hint: 'blur' });
        await sleep(120);
        continue;
      }

      const enhanced = flatten(frame);
      this.ctx.putImageData(new ImageData(enhanced.data, W, H), 0, 0);
      const t0 = performance.now();
      let data;
      try {
        ({ data } = await worker.recognize(this.canvas, {}, { blocks: true, text: false }));
      } catch (e) {
        console.warn(e);
        await sleep(300);
        continue;
      }
      if (!this.running) break;
      const ms = performance.now() - t0;
      this.timings.push(ms);
      if (this.timings.length > 5) this.timings.shift();

      const lines = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
        lines.push({ text: l.text, confidence: l.confidence, bbox: l.bbox });
      }
      const parsed = parseFrame(lines);
      this.acc.addFrame(parsed);

      // 認識した行の枠を画面座標で保存(描画ループで表示する)
      const k = g.screen.w / W;
      this.lastBoxes = parsed.lineKinds.filter((x) => x.bbox && x.kind !== 'other').map((x) => ({
        kind: x.kind,
        x: g.screen.x + x.bbox.x0 * k, y: g.screen.y + x.bbox.y0 * k,
        w: (x.bbox.x1 - x.bbox.x0) * k, h: (x.bbox.y1 - x.bbox.y0) * k,
      }));
      this.boxTime = performance.now();
      const avg = this.timings.reduce((a, b) => a + b, 0) / this.timings.length;
      this.onStatus({ phase: 'scanning', ms: avg, lines: lines.length });
      this.onUpdate(this.acc.snapshot());
    }
  }

  _drawLoop() {
    if (!this.running) return;
    const c = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const age = (performance.now() - this.boxTime) / 1000;
    const alpha = Math.max(0, 1 - age / 2.5);
    if (alpha > 0) {
      const styles = getComputedStyle(document.documentElement);
      const col = {
        item: styles.getPropertyValue('--ocr-item').trim() || '#3ddc97',
        discount: styles.getPropertyValue('--ocr-item').trim() || '#3ddc97',
        total: styles.getPropertyValue('--ocr-total').trim() || '#ffc24b',
        date: styles.getPropertyValue('--ocr-meta').trim() || '#9ec5ff',
      };
      for (const b of this.lastBoxes) {
        const color = col[b.kind] || 'rgba(255,255,255,0.55)';
        ctx.globalAlpha = alpha * (col[b.kind] ? 0.95 : 0.5);
        ctx.strokeStyle = color;
        ctx.lineWidth = col[b.kind] ? 2 : 1;
        roundRect(ctx, b.x - 3, b.y - 2, b.w + 6, b.h + 4, 4);
        ctx.stroke();
        if (col[b.kind]) {
          ctx.globalAlpha = alpha * 0.16;
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(() => this._drawLoop());
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
