// レシート文字列の解析と、複数フレームの認識結果の統合。
// DOM に依存しない純粋なロジックなので Node でもテストできる。

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\u3005\\u30fc';
const RE_CJK_SPACE = new RegExp(`([${CJK}])[\\s\\u3000]+(?=[${CJK}])`, 'g');
const RE_HAS_JA = new RegExp(`[${CJK}]`);
const RE_JA_ALL = new RegExp(`[${CJK}]`, 'g');

/**
 * 紙の縁や影を OCR が文字として読んだもの(行頭・行末の「|」「_」、金額のあとに離れて付いた1〜2文字など)を取り除く。
 * 列の空白は残す。
 */
export function stripEdgeJunk(raw) {
  let s = (raw || '').normalize('NFKC').replace(/\s+$/, '');
  s = s.replace(/^\s*[|!_\[\]{}「」『』【】Il]+\s+/, '');
  s = s.replace(/\s+[|!_\[\]{}「」『』【】]+$/, '');
  // 金額や「)」のあとに離れて付いた1〜2文字(「¥516 計」「¥1,320 革」)。軽減税率などの印は残す
  s = s.replace(/([\d)])\s+([^\s\d※*]{1,2})$/, (m, a, b) => (/^[軽外内非税TEXRJ%円]+$/.test(b) ? m : a));
  // 金額のない行の末尾に大きく離れて付いた、ひらがな1文字や記号(「ホワイトニ  に」)
  s = s.replace(/(\S)\s{2,}([\p{Script=Hiragana}|!_。、・])$/u, '$1');
  return s;
}

/** OCR の1行を比較しやすい形に整える */
export function normalizeLine(raw) {
  let s = stripEdgeJunk(raw);
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
  payment: /(現金|クレジット|ｸﾚｼﾞｯﾄ|カード|デビット|電子マネー|PayPay|PAYPAY|楽天ペイ|d払い|au ?PAY|メルペイ|Suica|SUICA|PASMO|ICOCA|nanaco|WAON|楽天Edy|Edy|QUICPay|交通系|コード決済|バーコード決済|お支払|支払|残高|利用額|VISA|JCB|AMEX)/,
  discount: /(値引|値引き|割引|割り引|クーポン|OFF|オフ|引$)/i,
  meta: /(TEL|Tel|電話|FAX|領収|レシート|No[.:]|NO[.:]|登録番号|担当|レジ|責任者|点数|\d+点$|営業時間|ありがとう|お越し|ご来店|来店|いらっしゃいませ|毎度|本日も|お問い?合わせ|〒|http|www|伝票|取引|承認|会員|ポイント|pt|P残高|発行|再発行|お客様|お得|店舗|返品|交換|保管|控え)/i,
};

// 支払方法の手がかり。英字は大文字小文字を区別する(「id」などの誤検出を避けるため)
const PAY_SERVICES = [
  [/PayPay|PAYPAY|ペイペイ/, 'PayPay', 'qr'],
  [/楽天ペイ/, '楽天ペイ', 'qr'],
  [/d払い/, 'd払い', 'qr'],
  [/au ?PAY|au ?Pay/, 'au PAY', 'qr'],
  [/メルペイ/, 'メルペイ', 'qr'],
  [/LINE ?Pay/, 'LINE Pay', 'qr'],
  [/Suica|SUICA|スイカ/, 'Suica', 'emoney'],
  [/PASMO|パスモ/, 'PASMO', 'emoney'],
  [/ICOCA|イコカ/, 'ICOCA', 'emoney'],
  [/Kitaca|TOICA|manaca|nimoca|SUGOCA|はやかけん/, null, 'emoney'],
  [/QUICPay|QUICPAY|クイックペイ/, 'QUICPay', 'emoney'],
  [/(?:^|[^A-Za-z])iD(?:[^A-Za-z]|$)/, 'iD', 'emoney'],
  [/nanaco|ナナコ/, 'nanaco', 'emoney'],
  [/WAON|ワオン/, 'WAON', 'emoney'],
  [/楽天 ?Edy|Edy|エディ/, '楽天Edy', 'emoney'],
];
const PAY_BRANDS = [
  [/VISA|Visa/, 'VISA'],
  [/Master ?[Cc]ard|MASTER|Master/, 'Mastercard'],
  [/JCB/, 'JCB'],
  [/AMEX|American ?Express|AMERICAN ?EXPRESS/, 'American Express'],
  [/Diners|DINERS/, 'Diners Club'],
];
const PAY_TYPES = [
  [/デビット|DEBIT|Debit/, 'debit'],
  [/クレジット|ｸﾚｼﾞｯﾄ|クレカ|CREDIT|Credit|カード払|カード支払|カードご利用|カード利用/, 'credit'],
  [/コード決済|バーコード決済|QR決済|スマホ決済/, 'qr'],
  [/電子マネー|交通系/, 'emoney'],
  [/現金|お?預り|お?預かり|お?釣り?|おつり|釣銭/, 'cash'],
];
const PAY_TYPE_LABEL = { cash: '現金', credit: 'クレジット', debit: 'デビット', emoney: '電子マネー', qr: 'QR決済' };

/**
 * 1行から支払方法の手がかりを取り出す。
 * @returns {{type?:string, service?:string, brand?:string, last4?:string}}
 */
export function detectPayment(raw) {
  const s = (raw || '').normalize('NFKC');
  const hint = {};
  for (const [re, name, type] of PAY_SERVICES) {
    const m = s.match(re);
    if (m) { hint.service = name || m[0]; hint.type = type; break; }
  }
  for (const [re, brand] of PAY_BRANDS) if (re.test(s)) { hint.brand = brand; break; }
  if (!hint.type) for (const [re, type] of PAY_TYPES) if (re.test(s)) { hint.type = type; break; }
  if (hint.brand && !hint.type) hint.type = 'credit';
  // 「TS3カード ¥3,939」のように、カード名と金額だけの行はカード払い(ポイントカードなどは除く)
  if (!hint.type || (hint.type === 'credit' && !hint.service)) {
    const t = normalizeLine(raw);
    // OCR は「カード」を「カガード」「カ一ド」のように崩すことがある
    const m = t.match(/^(.{0,14}?カ[ガカ]?[ー一-]?ド)(?:払い?|支払い?)?\s*[¥\\]?\s*[\d,.\s]+$/);
    if (m && /\d/.test(t) && !/(ポイント|会員|Ponta|Tカード|スタンプ|メンバーズ|番号|No)/i.test(t)) {
      hint.type = hint.type || 'credit';
      const tokens = m[1].split(/\s+/);
      const nm = (tokens[tokens.length - 1] || '').replace(/^[^\p{L}\p{N}]+/u, '');
      if (nm.length >= 3) hint.service = nm;
    }
  }
  // 伏せ字のカード番号「************1234」「XXXX-XXXX-XXXX-1234」の下4桁(ポイントカードの番号は除く)
  if (!/(ポイント|会員|Ponta|Tカード|nanaco番号)/.test(s)) {
    // OCR は伏せ字の「*」を「ネ」「米」などと読むことがある
    const compact = s.replace(/[\s-]/g, '');
    const m = compact.match(/[*xX•●※#ネ米+・]{4,}(\d{4})(?!\d)/) || compact.match(/カード(?:番号|No\.?|NO\.?)\D*?(\d{4})$/);
    if (m) hint.last4 = m[1];
  }
  return hint;
}

// 電話番号(「072-804-4193」「03(1234)5678」など)。店名は電話番号と同じ行かその上にあることが多い
const RE_PHONE = /0\d{1,4}\s*[-ー−(（]\s*\d{1,4}\s*[-ー−)）]\s*\d{3,4}/;
const STORE_SUFFIX = /(店|局|株式会社|\(株\)|ストア|マート|ショップ|商店|薬局|ドラッグ|センター)/;

// 末尾の金額: 「¥1,280」「1280円」「398※」「-50」「▲50」など
const RE_PRICE_TAIL = /(?:^|[\s:])([-▲△]?)\s*(¥?)\s*((?:\d{1,3}(?:[,.]\d{3})+)|\d{1,6})\s*(円)?\s*([※*軽外内非税TEXRJ8%]{0,3})\s*\)?\s*$/;
// 数量の行(「2コX単99」「3コ×単 767」など)。OCR は「×」を「メ」「x」と読んだり、余計な記号を挟んだりする
const RE_QTY = /(\d+)\s*(個|コ|点|本|枚|袋|パック|P|ヶ)?\s*[xX×*@＠メ]\s*(単)?\s*¥?\s*\d+|単[^\d\s]{0,3}\s*¥?\s*\d+|@\s*¥?\s*\d+|\d+\s*(個|コ)\s*$/;
// 数量の行から数字や記号を除いた残り(品名らしい文字がほとんど残らなければ数量の行)
const qtyResidue = (s) => s.replace(/[\d\sxX×*@＠メコ個点本枚袋ヶ単_\-.,:;|¥]/g, '');

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
  if (!m) {
    // 「…ケ 隊1,320」: ¥ が別の1文字に化けて数字にくっついた金額(単位の文字は除く)
    // (漢字どうしの空白を詰める前の、列の空白を残した版で判定する)
    const y = fixDigits(raw || s).match(/^(.*\S)\s+([^\s\d食個本枚箱袋入切コgmlLP%])(\d{1,3}(?:,\d{3})+|\d{3,6})\s*([※*軽外内]{0,2})$/);
    if (y) return { value: parseInt(y[3].replace(/,/g, ''), 10), negative: false, hasYen: true, mark: y[4] || '', head: normalizeLine(y[1]) };
    // 「…ケー.320」「…ケー, 320」: 「¥1,」が崩れて千の位が欠けた金額(合計との照合で補う)
    const k = fixed.match(/^(.*[^\d\s,.])\s*[,.]\s*(\d{3})\s*([※*軽外内]{0,2})$/);
    if (k && k[1].trim().length >= 2) return { value: parseInt(k[2], 10), negative: false, hasYen: false, mark: k[3] || '', head: `${k[1].trim()},`, lostThousands: true };
    return null;
  }
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
  s = s.replace(/^[\s*※#・.\-:|_!]+/, '');
  s = s.replace(/^\d{4,}\s*/, ''); // JAN などの商品コード
  s = s.replace(/^\d{1,3}\s+(?=\S)/, ''); // 行頭の連番
  s = s.replace(/[\s*※:・.。、\-_|]+$/, '');
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


/**
 * 1フレーム分の OCR 行を解析する。
 * @param {{text:string, confidence:number, bbox?:object}[]} lines 上から順の行
 */
export function parseFrame(lines, today = new Date()) {
  const out = {
    items: [], total: null, subtotal: null, taxOut: null, taxIn: null,
    date: null, store: [], payment: null, payHint: {}, lineKinds: [],
    payAmount: null, deposit: null, change: null, taxBases: {},
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
    const spaced = stripEdgeJunk(ln.text).replace(/[\\￥]/g, '¥').trim();

    // 支払方法の手がかり(現金より具体的な支払方法を優先する)
    const ph = detectPayment(ln.text);
    if (ph.type && (!out.payHint.type || out.payHint.type === 'cash')) out.payHint.type = ph.type;
    for (const k of ['service', 'brand', 'last4']) if (ph[k] && !out.payHint[k]) out.payHint[k] = ph[k];

    if (anchorLine < 0 && /(TEL|Tel|電話|〒|都|道|府|県|市|区|町)/.test(text) && /\d/.test(text)) anchorLine = idx;
    if (RE_PHONE.test(text)) {
      if (anchorLine < 0) anchorLine = idx;
      // 「アカカベ枚方公園店 072-804-4193」のように電話番号と同じ行にある店名
      const nm = cleanName(text.replace(RE_PHONE, ' ').replace(/(TEL|Tel|tel|電話|FAX|Fax)\s*[:.]?/g, ' '));
      if (looksLikeName(nm) && conf >= 50 && !/\d{3,}/.test(nm)) storeCands.push({ name: nm, conf, order: idx - 0.5, strong: STORE_SUFFIX.test(nm) });
      kind.kind = 'meta';
      return;
    }
    const date = findDate(text, today);
    if (date && anchorLine < 0) anchorLine = idx;
    if (date) {
      if (!out.date || conf > out.date.conf) out.date = { value: date, conf };
      kind.kind = 'date'; return;
    }

    const price = parsePriceTail(text, spaced);
    const head = price ? price.head : text;

    // 「小計」「合計」の読み違い(「人計」など)も金額の集計行として扱う
    if (KW.subtotal.test(head) || (/^.{0,2}計$/.test(cleanName(head)) && !KW.total.test(head))) {
      if (price) { out.subtotal = price.value; kind.kind = 'subtotal'; }
      pendingName = null; return;
    }
    const taxish = /^[(\[「『]/.test(head) || /(税合計|消費税|内税|外税|税額|対象|課税)/.test(head);
    if (KW.total.test(head) && !taxish) {
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
      // 「(内10% 対象 ¥3,423)」: 税率ごとの対象額(合計の手がかりになる)
      const rate = head.match(/(\d{1,2})\s*%/);
      if (price && rate && /対象/.test(head)) out.taxBases[rate[1]] = price.value;
      kind.kind = 'tax'; pendingName = null; return;
    }
    if (KW.deposit.test(head) || ((KW.payment.test(head) || ph.type) && price)) {
      if (price) {
        if (/(預り|預かり)/.test(head)) out.deposit = price.value;
        else if (/(釣|おつり)/.test(head)) out.change = price.value;
        else if (!/(残高|ポイント|利用可能|チャージ)/.test(head) && price.value > 0) out.payAmount = price.value;
      }
      kind.kind = 'payment'; pendingName = null; return;
    }
    if (KW.meta.test(head) && !RE_QTY.test(head)) { kind.kind = 'meta'; return; }
    // 「(8%対象 ¥1,214)」のような括弧書きは税の内訳。「内10%」「外 8%」も(括弧が読めていなくても)税の内訳
    if (/^[(\[]/.test(head) || /\)\s*$/.test(text) || /(^|[\s(\[|])[内外]\s*\d{1,2}\s*%/.test(head)) { kind.kind = 'tax'; pendingName = null; return; }
    if (afterTotal) { pendingName = null; return; }

    if (price) {
      const isDiscount = KW.discount.test(head) || price.negative;
      let name = cleanName(head);
      const isQtyLine = RE_QTY.test(head) && (!looksLikeName(name) || qtyResidue(head).length < 2);
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
          out.items.push({ name: pendingName.name, price: price.value, conf: Math.min(conf, pendingName.conf), y: pendingName.y, line: pendingName.line, reduced: pendingName.reduced || /[※軽]/.test(price.mark || '') || /[※軽]\s*$/.test(text) });
          kind.kind = 'item';
          out.lineKinds[pendingName.line].kind = 'item';
        } else {
          kind.kind = 'qty';
        }
        pendingName = null; return;
      }
      if (looksLikeName(name) && price.value >= 10 && price.value <= 999999) {
        // 「…ケー, 320」のように金額の直前に区切り記号だけ残っているときは、先頭の桁が欠けた疑いがある
        const lost = (price.lostThousands || /[,、.]$/.test(head.trim())) && price.value < 1000;
        name = name.replace(/[,、.\s]+$/, '');
        // 軽減税率(8%)の品目の印(「※サッポロ一番」「¥516※」「¥160軽」)
        const reduced = /^[\s|]*[※*★☆]/.test(head) || /[※軽*]/.test(price.mark || '') || /[※軽]\s*\)?$/.test(text);
        out.items.push({ name, price: price.value, conf, y: ln.bbox?.y0 ?? idx, line: idx, lost, reduced });
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
        storeCands.push({ name, conf, order: idx, strong: STORE_SUFFIX.test(name) });
      }
      pendingName = { name, conf, y: ln.bbox?.y0 ?? idx, line: idx, reduced: /^[\s|]*[※*★☆]/.test(text) };
      kind.kind = 'text';
    }
  });
  if (anchorLine >= 0) out.store = storeCands.filter((c) => c.order < anchorLine).slice(0, 2);
  out.payment = PAY_TYPE_LABEL[out.payHint.type] || null;
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
    this.payHints = { type: new Map(), service: new Map(), brand: new Map(), last4: new Map() };
    this.payAmounts = new Map();
    this.deposits = new Map();
    this.changes = new Map();
    this.taxBases = new Map(); // 税率 → (金額 → 票)
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
    for (const k of Object.keys(this.payHints)) if (parsed.payHint?.[k]) ReceiptAccumulator.vote(this.payHints[k], parsed.payHint[k], 1);
    for (const s of parsed.store) this._addStore(s);
    if (parsed.payAmount) ReceiptAccumulator.vote(this.payAmounts, parsed.payAmount, 1);
    if (parsed.deposit != null) ReceiptAccumulator.vote(this.deposits, parsed.deposit, 1);
    if (parsed.change != null) ReceiptAccumulator.vote(this.changes, parsed.change, 1);
    for (const [rate, v] of Object.entries(parsed.taxBases || {})) {
      if (!this.taxBases.has(rate)) this.taxBases.set(rate, new Map());
      ReceiptAccumulator.vote(this.taxBases.get(rate), v, 1);
    }

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
      if (it.lost) ex.lost = true;
      ex.reducedVotes = (ex.reducedVotes || 0) + (it.reduced ? 1 : -1);
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
          keep.lost = keep.lost || drop.lost;
          keep.reducedVotes = (keep.reducedVotes || 0) + (drop.reducedVotes || 0);
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

  _paymentHint() {
    const types = this.payHints.type;
    // 現金以外の手がかりが一度でも見えたら、そちらを優先する
    const nonCash = new Map([...types].filter(([k]) => k !== 'cash'));
    const hint = {
      type: ReceiptAccumulator.best(nonCash.size ? nonCash : types),
      service: ReceiptAccumulator.best(this.payHints.service),
      brand: ReceiptAccumulator.best(this.payHints.brand),
      last4: ReceiptAccumulator.best(this.payHints.last4),
    };
    for (const k of Object.keys(hint)) if (hint[k] == null) delete hint[k];
    return hint;
  }

  /**
   * 合計金額を決める。「合計」の行が読めないレシート(太字の倍角など)もあるので、
   * カード等の支払額・お預り−お釣り・税率ごとの対象額の和も手がかりにして、
   * 票の多い金額を採る。品目の合計と一致する金額はさらに信頼する。
   */
  _chooseTotal(sum, taxOut) {
    const best = ReceiptAccumulator.best;
    const score = new Map();
    const add = (v, w, src) => {
      if (v == null || !(v > 0)) return;
      const cur = score.get(v) || { w: 0, src: [] };
      cur.w += w;
      if (!cur.src.includes(src)) cur.src.push(src);
      score.set(v, cur);
    };
    for (const [v, w] of this.totals) add(v, w * 2, 'line');
    for (const [v, w] of this.payAmounts) add(v, w * 1.5, 'payment');
    const dep = best(this.deposits), chg = best(this.changes);
    if (dep != null && chg != null && dep - chg > 0) add(dep - chg, 1.5, 'cash');
    if (this.taxBases.size) {
      let s = 0;
      for (const m of this.taxBases.values()) s += best(m);
      add(s, 1, 'taxbase');
      if (taxOut != null) add(s + taxOut, 1, 'taxbase');
    }
    for (const [v, o] of score) if (sum > 0 && (v === sum || (taxOut != null && v === sum + taxOut))) o.w += 1;
    let total = null, info = null;
    for (const [v, o] of score) if (!info || o.w > info.w) { total = v; info = o; }
    return { total, source: info ? (info.src.includes('line') ? 'line' : info.src[0]) : null };
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
      lost: !!ex.lost,
      reduced: (ex.reducedVotes || 0) > 0,
      variants: [...ex.prices.keys()],
    }));
    const taxOut = ReceiptAccumulator.best(this.taxOut);
    const rawSum = list.filter((x) => x.confirmed).reduce((a, x) => a + x.price, 0);
    const { total, source: totalSource } = this._chooseTotal(rawSum, taxOut);
    // 金額が合計と同じ「品目」は、合計や支払いの行を読み違えたもの(ほかに品目があるとき)
    if (total != null && list.filter((x) => x.confirmed).length > 1) {
      for (const x of list) if (x.confirmed && x.price === total) { x.confirmed = false; x.totalLike = true; }
    }
    const bases = {};
    for (const [rate, m] of this.taxBases) bases[rate] = ReceiptAccumulator.best(m);
    const reconciled = reconcile(list, total, taxOut, this.taxBases.size ? bases : null);
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
      totalSource,
      subtotal: ReceiptAccumulator.best(this.subtotals),
      taxOut,
      match,
      reconciled,
      date: ReceiptAccumulator.best(this.dates),
      store: store ? store.name : '',
      payment: ReceiptAccumulator.best(this.payments),
      paymentHint: this._paymentHint(),
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
export function reconcile(list, total, taxOut, bases = null) {
  if (total == null) return null;
  const confirmed = list.filter((x) => x.confirmed);
  if (!confirmed.length) return null;
  const sum = confirmed.reduce((a, x) => a + x.price, 0);
  const targets = [total];
  if (taxOut != null) targets.push(total - taxOut);
  if (targets.includes(sum)) return null;
  // 候補が1つならそれ。複数あるときは、税率ごとの対象額(「(内 8% 対象 ¥516)」など)と
  // 軽減税率の印の付いた品目の合計が合う候補が1つだけなら、それを選ぶ
  const unique = (cands) => {
    if (cands.length === 1) return cands[0];
    if (!bases || cands.length < 2) return null;
    const ok = cands.filter((c) => taxConsistent(list, bases, c));
    return ok.length === 1 ? ok[0] : null;
  };

  // (1) 別のフレームで読めていた金額に差し替える
  let c = unique(confirmed.flatMap((it) => it.variants.filter((p) => p !== it.price && targets.includes(sum - it.price + p)).map((p) => ({ it, p }))));
  if (c) { c.it.price = c.p; c.it.adjusted = true; return { kind: 'variant', id: c.it.id }; }
  // (2) まだ確定していない候補を1件足すと合う
  c = unique(list.filter((it) => !it.confirmed && targets.includes(sum + it.price)).map((it) => ({ it, add: true })));
  if (c) { c.it.confirmed = true; c.it.adjusted = true; return { kind: 'add', id: c.it.id }; }
  // (3) 見えた回数の少ない品目を1件外すと合う
  c = unique(confirmed.filter((it) => it.hits <= 2 && targets.includes(sum - it.price)).map((it) => ({ it, drop: true })));
  if (c) { c.it.confirmed = false; return { kind: 'drop', id: c.it.id }; }
  // 先頭の桁が欠けた金額(¥1,320 → ¥320)を補うと合う候補
  const lead = [];
  for (const it of confirmed) {
    if (it.price <= 0) continue;
    const unit = 10 ** String(it.price).length;
    for (const t of targets) {
      const diff = t - sum;
      if (diff > 0 && diff % unit === 0 && diff / unit <= 9) lead.push({ it, p: it.price + diff });
    }
  }
  // (4) 金額の直前に区切り記号が残っていた(欠けた疑いのある)品目なら、それを補う
  c = unique(lead.filter((x) => x.it.lost));
  if (c) { c.it.price = c.p; c.it.adjusted = true; return { kind: 'lead', id: c.it.id }; }
  // (5) 数字1文字の読み違いを直すと合う
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
  // (6) 先頭の桁を補える品目が1つだけなら補う
  c = unique(lead);
  if (c) { c.it.price = c.p; c.it.adjusted = true; return { kind: 'lead', id: c.it.id }; }
  return null;
}

/**
 * 補正の候補 c({it, p} 金額の差し替え / {it, add} 追加 / {it, drop} 除外)を当てはめたとき、
 * 軽減税率の品目(8%)とそれ以外(10%)の合計が、レシートの税率ごとの対象額と一致するか。
 * 値引きの行は直前の品目と同じ税率として数える。
 */
function taxConsistent(list, bases, c) {
  const sums = { 8: 0, 10: 0 };
  let lastReduced = false;
  for (const it of list) {
    const included = it === c.it ? (c.drop ? false : c.add ? true : it.confirmed) : it.confirmed;
    if (!included) continue;
    const price = it === c.it && c.p != null ? c.p : it.price;
    const red = it.discount ? lastReduced : !!it.reduced;
    if (!it.discount) lastReduced = red;
    sums[red ? 8 : 10] += price;
  }
  for (const rate of ['8', '10']) if (bases[rate] != null && sums[rate] !== bases[rate]) return false;
  return true;
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

/**
 * 横幅を半分にして読み直した結果のうち、採用する行を選ぶ。
 * 読み直しは倍角の「合計」「お釣り」などのためのものなので、それらの語を含む行があるときだけ採用する
 * (普通の品目の行を縮めると文字化けするため)。
 * @param {{text:string, confidence:number}} original 元の行
 * @param {{text:string, confidence:number}[]} rereadLines 読み直した結果の行
 * @returns {{text:string, confidence:number} | null}
 */
export function pickReread(original, rereadLines) {
  const KEY = /(合計|小計|釣|預|お買上|現金)/;
  if (KEY.test(normalizeLine(original.text))) return null;
  const ls = rereadLines.map((l) => ({ text: stripEdgeJunk(l.text), confidence: l.confidence })).filter((l) => l.text.trim());
  for (let i = 0; i < ls.length; i++) {
    if (!KEY.test(normalizeLine(ls[i].text))) continue;
    let text = ls[i].text, conf = ls[i].confidence;
    // 「合計」と金額が別の行に分かれて読まれたときはつなぐ
    if (!/\d/.test(text) && ls[i + 1] && /\d/.test(ls[i + 1].text)) { text = `${text}     ${ls[i + 1].text}`; conf = (conf + ls[i + 1].confidence) / 2; }
    return { text, confidence: Math.max(conf, original.confidence + 1) };
  }
  return null;
}
