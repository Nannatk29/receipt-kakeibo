// レシート文字列の解析と、複数フレームの認識結果の統合。
// DOM に依存しない純粋なロジックなので Node でもテストできる。

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\u3005\\u30fc';
const RE_CJK_SPACE = new RegExp(`([${CJK}])[\\s\\u3000]+(?=[${CJK}])`, 'g');
const RE_HAS_JA = new RegExp(`[${CJK}]`);
const RE_JA_ALL = new RegExp(`[${CJK}]`, 'g');

/** OCR の1行を比較しやすい形に整える */
export function normalizeLine(raw) {
  let s = (raw || '').normalize('NFKC');
  s = s.replace(/[‐-―−－]/g, '-'); // 各種ダッシュ
  s = s.replace(RE_CJK_SPACE, '$1').replace(RE_CJK_SPACE, '$1');
  // よくある誤認識: 「計」が「言十」に割れる、¥ が \ や Y になる
  s = s.replace(/言\s*十/g, '計').replace(/合\s*言/g, '合計');
  s = s.replace(/[\\￥]\s*(?=[\dOoIl|])/g, '¥').replace(/(^|[\s(])[Yy]\s*(?=\d)/g, '$1¥');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 名前比較用のキー(空白・記号を除去) */
export function nameKey(name) {
  return (name || '').normalize('NFKC').replace(/[\s　・,.:;'"`_\-~*※#()[\]{}<>|/\\]/g, '').toLowerCase();
}

/** 0..1 の類似度(正規化レーベンシュタイン) */
export function similarity(a, b) {
  a = nameKey(a); b = nameKey(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

// 行の種類を判定するキーワード
const KW = {
  total: /(合計|総合計|お?買上げ?計|お買い?上げ?合計|ご?請求額|お支払い?金?額|税込計)/,
  subtotal: /(小計)/,
  taxOut: /(外税|外消費税)/,
  taxIn: /(内税|内消費税|消費税等|消費税額|税額)/,
  taxBase: /(対象|課税|非課税|税率)/,
  deposit: /(お?預り|お?預かり|預り金|お?釣り?|釣銭|おつり|釣り銭)/,
  payment: /(現金|クレジット|ｸﾚｼﾞｯﾄ|カード|電子マネー|PayPay|楽天ペイ|d払い|au ?PAY|メルペイ|Suica|PASMO|ICOCA|nanaco|WAON|楽天Edy|Edy|iD|QUICPay|交通系|コード決済|バーコード決済|お支払|支払|残高|利用額)/i,
  discount: /(値引|値引き|割引|割り引|クーポン|OFF|オフ|引$)/i,
  meta: /(TEL|Tel|電話|FAX|領収|レシート|No[.:]|NO[.:]|登録番号|担当|レジ|責任者|点数|\d+点$|営業時間|ありがとう|お越し|お問い?合わせ|〒|http|www|伝票|取引|承認|会員|ポイント|pt|P残高|発行|再発行|お客様|お得|店舗|返品|交換|保管|控え)/i,
};

const PAYMENT_LABELS = [
  [/(PayPay|楽天ペイ|d払い|au ?PAY|メルペイ|コード決済|バーコード決済)/i, 'QR決済'],
  [/(Suica|PASMO|ICOCA|nanaco|WAON|Edy|iD|QUICPay|交通系|電子マネー)/i, '電子マネー'],
  [/(クレジット|ｸﾚｼﾞｯﾄ|カード|VISA|Master|JCB|AMEX)/i, 'クレジット'],
  [/(現金|お?預り|お?預かり|お?釣り?|おつり)/, '現金'],
];

// 末尾の金額: 「¥1,280」「1280円」「398※」「-50」「▲50」など
const RE_PRICE_TAIL = /(?:^|[\s:])([-▲△]?)\s*(¥?)\s*((?:\d{1,3}(?:[,.]\d{3})+)|\d{1,6})\s*(円)?\s*([※*軽外内非税TEXRJ8%]{0,3})\s*\)?\s*$/;
const RE_QTY = /(\d+)\s*(個|コ|点|本|枚|袋|パック|P|ヶ)?\s*[xX×*@＠]\s*(単)?\s*¥?\s*\d+|単\s*¥?\s*\d+|@\s*¥?\s*\d+|\d+\s*(個|コ)\s*$/;

/** OCR の数字によくある誤認識を直す(数字の並びの中だけ) */
// (古い iOS Safari は正規表現の後読みに対応していないため、1文字ずつ見る)
function fixDigits(s) {
  const isNumCtx = (c) => c !== undefined && /[\d¥,]/.test(c);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = out[out.length - 1], next = s[i + 1], next2 = s[i + 2];
    if ((c === 'O' || c === 'o') && (isNumCtx(prev) || /[\d,]/.test(next || ''))) out += '0';
    else if ((c === 'I' || c === 'l' || c === '|') && (isNumCtx(prev) || (/\d/.test(next || '') && /[\d,]/.test(next2 || '')))) out += '1';
    else out += c;
  }
  return out.replace(/(\d)\s*[,.]\s*(\d{3})(?!\d)/g, '$1,$2');
}

// 品名と金額のあいだの大きな空白(preserve_interword_spaces で残る)を使って
// 金額欄を切り出す。¥ が「革」「学」などに化けた場合もここで拾える。
function parsePriceColumn(raw) {
  const parts = raw.split(/\s{3,}/);
  if (parts.length < 2) return null;
  const head = parts.slice(0, -1).join(' ').trim();
  let seg = parts[parts.length - 1].trim();
  const neg = /^[-▲△]/.test(seg);
  seg = seg.replace(/^[-▲△]/, '');
  seg = seg.replace(/^[^\d\s]{1,2}(?=[\dOoIl|])/, ''); // 化けた ¥
  seg = fixDigits(seg);
  seg = seg.replace(/\)$/, '').replace(/[^\d]{1,3}$/, '').replace(/\s/g, ''); // ※ 軽 外 などの印
  if (!/^(\d{1,3}(,\d{3})+|\d{2,6})$/.test(seg)) return null;
  return { value: parseInt(seg.replace(/,/g, ''), 10), negative: neg, hasYen: true, mark: '', head };
}

function parsePriceTail(s, raw) {
  if (raw) {
    const col = parsePriceColumn(raw);
    if (col) { col.head = normalizeLine(col.head); return col; }
  }
  const fixed = fixDigits(s);
  const m = fixed.match(RE_PRICE_TAIL);
  if (!m) return null;
  if (!m) return null;
  const num = parseInt(m[3].replace(/[,.]/g, ''), 10);
  if (!Number.isFinite(num)) return null;
  // 「1.280」のような区切りなしの小数は金額として扱わない
  if (/\./.test(m[3]) && !/^\d{1,3}(\.\d{3})+$/.test(m[3])) return null;
  const head = fixed.slice(0, m.index + (m[0].startsWith(' ') || m[0].startsWith(':') ? 1 : 0)).trim();
  return {
    value: num,
    negative: !!m[1],
    hasYen: !!m[2] || !!m[4],
    mark: m[5] || '',
    head,
  };
}

function cleanName(head) {
  let s = head;
  s = s.replace(RE_QTY, ' ');
  s = s.replace(/^[\s*※#・.\-:]+/, '');
  s = s.replace(/^\d{4,}\s*/, ''); // JAN などの商品コード
  s = s.replace(/^\d{1,3}\s+(?=\S)/, ''); // 行頭の連番
  s = s.replace(/[\s*※:・.\-]+$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function looksLikeName(name) {
  if (!name) return false;
  const ja = (name.match(RE_JA_ALL) || []).length;
  const latin = (name.match(/[A-Za-z]/g) || []).length;
  if (ja >= 2) return true;
  if (ja >= 1 && name.length >= 2) return true;
  return latin >= 3;
}

/** 日付を探す。見つかれば 'YYYY-MM-DD' */
export function findDate(text, today = new Date()) {
  const s = fixDigits(text.normalize('NFKC'));
  const valid = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;
    const max = new Date(today.getTime() + 2 * 86400000);
    if (dt > max || y < 2000) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  let m = s.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/(令和|R)\s*(\d{1,2}|元)\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/);
  if (m) return valid(2018 + (m[2] === '元' ? 1 : +m[2]), +m[3], +m[4]);
  m = s.match(/(?:^|\D)(\d{2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)/);
  if (m) return valid(2000 + +m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return valid(today.getFullYear(), +m[1], +m[2]);
  return null;
}

function paymentOf(text) {
  for (const [re, label] of PAYMENT_LABELS) if (re.test(text)) return label;
  return null;
}

/**
 * 1フレーム分の OCR 行を解析する。
 * @param {{text:string, confidence:number, bbox?:object}[]} lines 上から順の行
 */
export function parseFrame(lines, today = new Date()) {
  const out = {
    items: [], total: null, subtotal: null, taxOut: null, taxIn: null,
    date: null, store: [], payment: null, lineKinds: [],
  };
  let pendingName = null; // 価格の無い商品名(次の数量行で確定するもの)
  let seenItem = false;
  let afterTotal = false; // 合計より下(お預り・お釣りなど)は品目にしない
  const storeCands = []; // 店名の候補。日付や TEL の行より上にあるときだけ採用する
  let anchorLine = -1;

  lines.forEach((ln, idx) => {
    const text = normalizeLine(ln.text);
    const conf = ln.confidence ?? 0;
    const kind = { idx, kind: 'other', bbox: ln.bbox, text };
    out.lineKinds.push(kind);
    if (!text || text.length < 2 || conf < 10) return;
    // 列の空白を残した版(NFKC と ¥ の補正だけ行う)
    const spaced = (ln.text || '').normalize('NFKC').replace(/[\\￥]/g, '¥').trim();

    if (anchorLine < 0 && /(TEL|Tel|電話|〒|都|道|府|県|市|区|町)/.test(text) && /\d/.test(text)) anchorLine = idx;
    const date = findDate(text, today);
    if (date && anchorLine < 0) anchorLine = idx;
    if (date) {
      if (!out.date || conf > out.date.conf) out.date = { value: date, conf };
      kind.kind = 'date'; return;
    }

    const price = parsePriceTail(text, spaced);
    const head = price ? price.head : text;
    const pay = paymentOf(text);

    // 「小計」「合計」の読み違い(「人計」など)も金額の集計行として扱う
    if (KW.subtotal.test(head) || (/^.{0,2}計$/.test(cleanName(head)) && !KW.total.test(head))) {
      if (price) { out.subtotal = price.value; kind.kind = 'subtotal'; }
      pendingName = null; return;
    }
    if (KW.total.test(head) && !KW.taxBase.test(head) && !/対象/.test(head)) {
      if (price && price.value > 0) {
        if (!out.total || conf > out.total.conf) out.total = { value: price.value, conf };
        kind.kind = 'total';
        afterTotal = true;
      }
      pendingName = null; return;
    }
    if (KW.taxOut.test(head)) {
      if (price) { out.taxOut = price.value; kind.kind = 'tax'; }
      pendingName = null; return;
    }
    if (KW.taxIn.test(head) || KW.taxBase.test(head)) {
      if (price && KW.taxIn.test(head)) out.taxIn = price.value;
      kind.kind = 'tax'; pendingName = null; return;
    }
    if (KW.deposit.test(head) || (KW.payment.test(head) && price)) {
      if (pay) out.payment = out.payment || pay;
      kind.kind = 'payment'; pendingName = null; return;
    }
    if (pay && !price) out.payment = out.payment || pay;
    if (KW.meta.test(head) && !RE_QTY.test(head)) { kind.kind = 'meta'; return; }
    // 「(8%対象 ¥1,214)」のような括弧書きは税の内訳
    if (/^[(\[]/.test(head) || /\)\s*$/.test(text)) { kind.kind = 'tax'; pendingName = null; return; }
    if (afterTotal) { pendingName = null; return; }

    if (price) {
      const isDiscount = KW.discount.test(head) || price.negative;
      let name = cleanName(head);
      const isQtyLine = RE_QTY.test(head) && !looksLikeName(name);
      if (isDiscount) {
        const value = price.value;
        if (value > 0 && value < 100000) {
          const label = (name && looksLikeName(name.replace(KW.discount, ''))) ? name : '値引';
          out.items.push({ name: label, price: -value, conf, y: ln.bbox?.y0 ?? idx, discount: true, line: idx });
          kind.kind = 'discount';
        }
        pendingName = null; return;
      }
      if (isQtyLine) {
        if (pendingName && price.value >= 10) {
          out.items.push({ name: pendingName.name, price: price.value, conf: Math.min(conf, pendingName.conf), y: pendingName.y, line: pendingName.line });
          kind.kind = 'item';
          out.lineKinds[pendingName.line].kind = 'item';
        } else {
          kind.kind = 'qty';
        }
        pendingName = null; return;
      }
      if (looksLikeName(name) && price.value >= 10 && price.value <= 999999) {
        out.items.push({ name, price: price.value, conf, y: ln.bbox?.y0 ?? idx, line: idx });
        kind.kind = 'item';
        seenItem = true;
        pendingName = null;
        return;
      }
      pendingName = null;
      return;
    }

    // 価格のない行
    if (RE_QTY.test(text)) { kind.kind = 'qty'; return; }
    const name = cleanName(text);
    if (looksLikeName(name)) {
      if (!seenItem && out.items.length === 0 && conf >= 60 && !/\d{3,}/.test(name)) {
        storeCands.push({ name, conf, order: idx, strong: /(店|株式会社|\(株\)|ストア|マート|ショップ|商店|薬局|ドラッグ)/.test(name) });
      }
      pendingName = { name, conf, y: ln.bbox?.y0 ?? idx, line: idx };
      kind.kind = 'text';
    }
  });
  if (anchorLine >= 0) out.store = storeCands.filter((c) => c.order < anchorLine).slice(0, 2);
  return out;
}

/** 複数フレームの結果を統合して、安定したレシート内容を作る */
export class ReceiptAccumulator {
  constructor() { this.reset(); }

  reset() {
    this.frames = 0;
    this.items = [];
    this.totals = new Map();
    this.subtotals = new Map();
    this.taxOut = new Map();
    this.dates = new Map();
    this.stores = [];
    this.payments = new Map();
    this.seq = 0;
  }

  static vote(map, key, w) { if (key == null) return; map.set(key, (map.get(key) || 0) + w); }
  static best(map) {
    let bk = null, bv = -1;
    for (const [k, v] of map) if (v > bv) { bk = k; bv = v; }
    return bk;
  }

  addFrame(parsed) {
    this.frames++;
    const w = (c) => 0.5 + Math.max(0, Math.min(100, c)) / 100;
    if (parsed.total) ReceiptAccumulator.vote(this.totals, parsed.total.value, w(parsed.total.conf));
    if (parsed.subtotal != null) ReceiptAccumulator.vote(this.subtotals, parsed.subtotal, 1);
    if (parsed.taxOut != null) ReceiptAccumulator.vote(this.taxOut, parsed.taxOut, 1);
    if (parsed.date) ReceiptAccumulator.vote(this.dates, parsed.date.value, w(parsed.date.conf));
    if (parsed.payment) ReceiptAccumulator.vote(this.payments, parsed.payment, 1);
    for (const s of parsed.store) this._addStore(s);

    // 1) 既存の品目と対応付ける(同じフレーム内で同じ品目に二重には対応させない)
    const used = new Set();
    const matches = parsed.items.map((it) => {
      let best = null, bestScore = 0;
      for (const ex of this.items) {
        if (used.has(ex) || !!ex.discount !== !!it.discount) continue;
        const sim = Math.max(...[...ex.names.keys()].map((n) => similarity(n, it.name)));
        const samePrice = ex.prices.has(it.price);
        const closePrice = !samePrice && digitsClose(ReceiptAccumulator.best(ex.prices), it.price);
        let score = 0;
        if (samePrice && sim >= 0.4) score = 1 + sim;
        else if (closePrice && sim >= 0.75) score = sim;
        else if (sim >= 0.9 && it.name.length >= 3) score = sim * 0.8;
        if (score > bestScore) { bestScore = score; best = ex; }
      }
      if (best) used.add(best);
      return best;
    });

    // 2) 新しい品目は、前後の既知品目の間に並べる
    parsed.items.forEach((it, i) => {
      let ex = matches[i];
      if (!ex) {
        let prev = -1, next = null;
        for (let j = i - 1; j >= 0; j--) if (matches[j]) { prev = matches[j].order; break; }
        for (let j = i + 1; j < matches.length; j++) if (matches[j]) { next = matches[j].order; break; }
        const order = next == null ? Math.max(prev, ...this.items.map((x) => x.order), 0) + 1 : (prev + next) / 2;
        ex = { id: ++this.seq, names: new Map(), prices: new Map(), hits: 0, conf: 0, order, discount: !!it.discount, frames: new Set() };
        this.items.push(ex);
        matches[i] = ex;
      }
      ReceiptAccumulator.vote(ex.names, it.name, w(it.conf));
      ReceiptAccumulator.vote(ex.prices, it.price, w(it.conf));
      ex.hits++;
      ex.conf = Math.max(ex.conf, it.conf);
      ex.frames.add(this.frames);
    });
    this._mergeDuplicates();
  }

  /**
   * 文字化けで別の品目として登録された同じ行をまとめる。
   * 同じ金額で並び順が隣り合い、しかも一度も同じフレームに同時に写っていない2件は、
   * 同じ行を別々に読んだものとみなす(本当に別の行なら同時に写るはず)。
   */
  _mergeDuplicates() {
    let merged = true;
    while (merged) {
      merged = false;
      const sorted = [...this.items].sort((a, b) => a.order - b.order);
      outer: for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j <= i + 2 && j < sorted.length; j++) {
          const a = sorted[i], b = sorted[j];
          if (a.discount !== b.discount) continue;
          if (ReceiptAccumulator.best(a.prices) !== ReceiptAccumulator.best(b.prices)) continue;
          if ([...a.frames].some((f) => b.frames.has(f))) continue;
          if (j === i + 2 && similarity(ReceiptAccumulator.best(a.names), ReceiptAccumulator.best(b.names)) < 0.3) continue;
          const [keep, drop] = a.hits >= b.hits ? [a, b] : [b, a];
          for (const [k, v] of drop.names) ReceiptAccumulator.vote(keep.names, k, v);
          for (const [k, v] of drop.prices) ReceiptAccumulator.vote(keep.prices, k, v);
          for (const f of drop.frames) keep.frames.add(f);
          keep.hits += drop.hits;
          keep.conf = Math.max(keep.conf, drop.conf);
          this.items = this.items.filter((x) => x !== drop);
          merged = true;
          break outer;
        }
      }
    }
  }

  _addStore(s) {
    for (const ex of this.stores) {
      if (similarity(ex.name, s.name) >= 0.6) {
        ex.score += 1 + (s.strong ? 1 : 0);
        if (s.conf > ex.conf) { ex.name = s.name; ex.conf = s.conf; }
        return;
      }
    }
    this.stores.push({ name: s.name, conf: s.conf, score: 1 + (s.strong ? 1 : 0) + (s.order === 0 ? 0.5 : 0) });
  }

  /** 現時点のレシート内容 */
  snapshot() {
    const list = [...this.items].sort((a, b) => a.order - b.order).map((ex) => ({
      id: ex.id,
      name: ReceiptAccumulator.best(ex.names),
      price: ReceiptAccumulator.best(ex.prices),
      hits: ex.hits,
      conf: ex.conf,
      discount: ex.discount,
      confirmed: ex.hits >= 2 || (this.frames <= 1 && ex.conf >= 70),
      adjusted: false,
      variants: [...ex.prices.keys()],
    }));
    const total = ReceiptAccumulator.best(this.totals);
    const taxOut = ReceiptAccumulator.best(this.taxOut);
    const reconciled = reconcile(list, total, taxOut);
    const confirmed = list.filter((x) => x.confirmed);
    const sum = confirmed.reduce((a, x) => a + x.price, 0);
    let match = false;
    if (total != null && confirmed.length) {
      match = sum === total || (taxOut != null && sum + taxOut === total);
    }
    const store = [...this.stores].sort((a, b) => b.score - a.score)[0];
    return {
      frames: this.frames,
      items: list,
      sum,
      total,
      subtotal: ReceiptAccumulator.best(this.subtotals),
      taxOut,
      match,
      reconciled,
      date: ReceiptAccumulator.best(this.dates),
      store: store ? store.name : '',
      payment: ReceiptAccumulator.best(this.payments),
    };
  }
}

// OCR で取り違えやすい数字
const CONFUSABLE = { 0: '689', 1: '74', 2: '7', 3: '85', 4: '19', 5: '638', 6: '058', 7: '12', 8: '03695', 9: '084' };

/**
 * 品目の合計がレシートの合計と合わないとき、1か所だけ直せば合う読み方を探す。
 * 解がちょうど1つに決まるときだけ採用し、その品目に adjusted 印を付ける。
 * @returns 補正した内容の説明(なければ null)
 */
export function reconcile(list, total, taxOut) {
  if (total == null) return null;
  const confirmed = list.filter((x) => x.confirmed);
  if (!confirmed.length) return null;
  const sum = confirmed.reduce((a, x) => a + x.price, 0);
  const targets = [total];
  if (taxOut != null) targets.push(total - taxOut);
  if (targets.includes(sum)) return null;
  const unique = (cands) => (cands.length === 1 ? cands[0] : null);

  // (1) 別のフレームで読めていた金額に差し替える
  let c = unique(confirmed.flatMap((it) => it.variants.filter((p) => p !== it.price && targets.includes(sum - it.price + p)).map((p) => ({ it, p }))));
  if (c) { c.it.price = c.p; c.it.adjusted = true; return { kind: 'variant', id: c.it.id }; }
  // (2) まだ確定していない候補を1件足すと合う
  c = unique(list.filter((it) => !it.confirmed && targets.includes(sum + it.price)));
  if (c) { c.confirmed = true; c.adjusted = true; return { kind: 'add', id: c.id }; }
  // (3) 見えた回数の少ない品目を1件外すと合う
  c = unique(confirmed.filter((it) => it.hits <= 2 && targets.includes(sum - it.price)));
  if (c) { c.confirmed = false; return { kind: 'drop', id: c.id }; }
  // (4) 数字1文字の読み違いを直すと合う
  const cands = [];
  for (const it of confirmed) {
    const s = String(Math.abs(it.price));
    for (let i = 0; i < s.length; i++) {
      for (const d of CONFUSABLE[s[i]] || '') {
        if (i === 0 && d === '0') continue;
        const v = parseInt(s.slice(0, i) + d + s.slice(i + 1), 10) * Math.sign(it.price || 1);
        if (targets.includes(sum - it.price + v)) cands.push({ it, p: v });
      }
    }
  }
  c = unique(cands);
  if (c) { c.it.price = c.p; c.it.adjusted = true; return { kind: 'digit', id: c.it.id }; }
  return null;
}

function digitsClose(a, b) {
  if (a == null || b == null) return false;
  const sa = String(Math.abs(a)), sb = String(Math.abs(b));
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) diff++;
  return diff <= 1;
}

// 店名からのカテゴリ推定
const CATEGORY_HINTS = [
  [/(スーパー|マート|イオン|西友|ライフ|マルエツ|イトーヨーカ|業務スーパー|オーケー|まいばすけっと|ベルク|ヤオコー|サミット|成城石井|八百屋|青果|鮮魚|精肉|食品)/, '食費'],
  [/(セブン|ローソン|ファミリーマート|ファミマ|ミニストップ|デイリーヤマザキ|コンビニ|NewDays)/, '食費'],
  [/(ドラッグ|薬局|マツキヨ|マツモトキヨシ|ウエルシア|ツルハ|スギ薬局|サンドラッグ|ココカラ|ダイソー|セリア|キャンドゥ|ホームセンター|カインズ|コーナン|ニトリ|無印)/, '日用品'],
  [/(レストラン|食堂|カフェ|珈琲|コーヒー|喫茶|ラーメン|寿司|すし|焼肉|居酒屋|マクドナルド|モス|吉野家|すき家|松屋|ガスト|サイゼリヤ|スターバックス|ドトール|タリーズ|弁当|うどん|そば)/, '外食'],
  [/(駅|鉄道|バス|タクシー|JR|メトロ|ガソリン|ENEOS|出光|コスモ|駐車場|パーキング)/, '交通'],
  [/(病院|クリニック|医院|歯科|調剤)/, '医療'],
  [/(書店|本屋|ブックス|映画|シネマ|ゲーム|ヨドバシ|ビックカメラ|ヤマダ|ユニクロ|GU|しまむら)/, '趣味・衣服'],
];
export function guessCategory(store, items = []) {
  const text = `${store || ''} ${items.map((i) => i.name).join(' ')}`;
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(text)) return cat;
  return null;
}
