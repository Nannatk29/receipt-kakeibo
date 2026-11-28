// カメラ映像の1フレームを OCR しやすい画像に整える。
// 入出力は ImageData 互換 {data: RGBA, width, height}。DOM 非依存。

/** RGBA → グレースケール(Uint8Array) */
export function toGray(img) {
  const { data, width, height } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return g;
}

/**
 * ピントの甘さの目安(ラプラシアンの分散)。手ブレしたフレームを飛ばすのに使う。
 * 速度のため step 画素おきに計算する。
 */
export function sharpness(gray, width, height, step = 2) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = step; y < height - step; y += step) {
    const row = y * width;
    for (let x = step; x < width - step; x += step) {
      const c = gray[row + x];
      const lap = 4 * c - gray[row + x - step] - gray[row + x + step] - gray[row - step * width + x] - gray[row + step * width + x];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * 照明ムラに強い局所二値化(Bradley 法、積分画像で O(n))。
 * 感熱紙の薄い印字やスマホの影でも文字が残りやすい。
 * @returns 二値化済み RGBA ImageData 互換オブジェクト
 */
export function binarize(img, { windowRatio = 1 / 12, t = 0.16 } = {}) {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += gray[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const s = Math.max(8, Math.round(w * windowRatio)) >> 1;
  // 紙の明るさ(上位 10% の輝度)。これより大幅に暗い領域は机などの背景として白で塗る
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= gray.length * 0.1) { paper = v; break; } }
  const bgLevel = paper * 0.55;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - s), y1 = Math.min(h - 1, y + s);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - s), x1 = Math.min(w - 1, x + s);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
        - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / count;
      const v = mean < bgLevel ? 255 : (gray[y * w + x] <= mean * (1 - t) ? 0 : 255);
      const k = (y * w + x) * 4;
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * 列ごとの明るさから、紙(レシート)の左右の端を探す。
 * 紙の外側(机など)は OCR がゴミ文字として読むので、塗りつぶすために使う。
 * 紙が画像の幅いっぱいのとき、または判断できないときは null。
 */
export function paperBounds(gray, w, h) {
  // 列ごとに「明るい側(上位 20%)」の明るさを求める。文字の多い列でも紙の白が残り、机は暗いまま
  const step = Math.max(1, Math.floor(h / 160));
  const rows = Math.ceil(h / step);
  const col = new Float64Array(w);
  const vals = new Uint8Array(rows);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y += step) vals[n++] = gray[y * w + x];
    const sorted = vals.subarray(0, n).sort();
    col[x] = sorted[Math.floor(n * 0.8)];
  }
  const k = Math.max(3, Math.round(w / 150));
  const sm = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let i = Math.max(0, x - k); i <= Math.min(w - 1, x + k); i++) { sum += col[i]; n++; }
    sm[x] = sum / n;
  }
  let max = 0, min = 255;
  for (const v of sm) { if (v > max) max = v; if (v < min) min = v; }
  if (max - min < 35) return null;
  const t = min + (max - min) * 0.5;
  let best = null, start = -1;
  for (let x = 0; x <= w; x++) {
    const bright = x < w && sm[x] > t;
    if (bright && start < 0) start = x;
    if (!bright && start >= 0) {
      if (!best || x - start > best.x1 - best.x0) best = { x0: start, x1: x - 1 };
      start = -1;
    }
  }
  if (!best || best.x1 - best.x0 < w * 0.4) return null;
  if (best.x0 <= 1 && best.x1 >= w - 2) return null;
  return best;
}

/**
 * 照明ムラを割り算で取り除き、階調は残したままコントラストを上げる。
 * 二値化より文字の輪郭が残るので、小さい文字では LSTM の認識が安定しやすい。
 */
export function flatten(img, { windowRatio = 1 / 10, gain = 1.15 } = {}) {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += gray[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let acc = 0, paper = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= gray.length * 0.1) { paper = v; break; } }
  const bgLevel = paper * 0.55;
  // 紙の左右の外側は白で塗る(紙の縁を「|」や漢字として読むのを防ぐ)。縁そのものも少し内側まで消す
  const pb = paperBounds(gray, w, h);
  const padIn = Math.max(2, Math.round(w * 0.004));
  const left = pb ? pb.x0 + padIn : -1, right = pb ? pb.x1 - padIn : w;
  const s = Math.max(8, Math.round(w * windowRatio)) >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - s), y1 = Math.min(h - 1, y + s);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - s), x1 = Math.min(w - 1, x + s);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
        - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0]) / count;
      let v;
      if (x < left || x > right || mean < bgLevel) v = 255;
      else {
        const r = gray[y * w + x] / (mean + 1); // 紙=約1、文字<1
        v = 255 - (1 - r) * 255 * gain * 2.2;
      }
      const k = (y * w + x) * 4;
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}
