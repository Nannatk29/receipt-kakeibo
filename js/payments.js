// 支払方法の定義・移行・レシートからの推定・集計。DOM 非依存。
import { similarity } from './parser.js';

export const PAYMENT_TYPES = [
  { key: 'cash', label: '現金', namePlaceholder: '現金' },
  { key: 'credit', label: 'クレジットカード', namePlaceholder: '例: 楽天カード' },
  { key: 'debit', label: 'デビットカード', namePlaceholder: '例: ○○銀行デビット' },
  { key: 'emoney', label: '電子マネー', namePlaceholder: '例: モバイルSuica' },
  { key: 'qr', label: 'QRコード決済', namePlaceholder: '例: PayPay' },
  { key: 'bank', label: '口座振替・振込', namePlaceholder: '例: ○○銀行' },
  { key: 'point', label: 'ポイント・商品券', namePlaceholder: '例: 楽天ポイント' },
  { key: 'other', label: 'その他', namePlaceholder: '例: 家族カード' },
];
export const typeLabel = (key) => (PAYMENT_TYPES.find((t) => t.key === key) || PAYMENT_TYPES[PAYMENT_TYPES.length - 1]).label;
export const isCardType = (key) => key === 'credit' || key === 'debit';

export const BRANDS = ['VISA', 'Mastercard', 'JCB', 'American Express', 'Diners Club'];

// 名前の候補(タップで入力できる)
export const NAME_SUGGESTIONS = {
  emoney: ['モバイルSuica', 'PASMO', 'ICOCA', 'iD', 'QUICPay', 'nanaco', 'WAON', '楽天Edy'],
  qr: ['PayPay', '楽天ペイ', 'd払い', 'au PAY', 'メルペイ'],
  point: ['楽天ポイント', 'Vポイント', 'Pontaポイント', 'dポイント', '商品券'],
};

export const METHOD_COLORS = ['#2f8a57', '#2c5fb8', '#c0392b', '#d4881f', '#7b52c7', '#14919b', '#c2477a', '#8a6d1d', '#4f5d75', '#e05d2a'];

const CANONICAL = { cash: '現金', credit: 'クレジットカード', debit: 'デビットカード', emoney: '電子マネー', qr: 'QR決済', bank: '口座振替', point: 'ポイント', other: 'その他' };
// 以前の版で記録に保存していた支払い名 → 種類
const LEGACY = { 現金: 'cash', クレジット: 'credit', クレジットカード: 'credit', デビット: 'debit', 電子マネー: 'emoney', QR決済: 'qr', その他: 'other' };

export function nextColor(methods) {
  const used = new Set(methods.map((m) => m.color));
  return METHOD_COLORS.find((c) => !used.has(c)) || METHOD_COLORS[methods.length % METHOD_COLORS.length];
}

export function defaultMethods() {
  return [{ id: 'pm_cash', name: '現金', type: 'cash', color: METHOD_COLORS[0] }];
}

/** 表示名(カードは下4桁つき) */
export function methodLabel(m) {
  if (!m) return '';
  return m.last4 ? `${m.name} ••${m.last4}` : m.name;
}

/**
 * 支払方法 ID を持たない記録(以前の版のデータや読み込んだバックアップ)に ID を割り当てる。
 * 必要なら支払方法を作る。records と methods を直接書き換え、変更があれば true。
 */
export function migrateRecords(records, methods, makeId) {
  let changed = false;
  const ids = new Set(methods.map((m) => m.id));
  for (const r of records) {
    if (r.paymentId && ids.has(r.paymentId)) continue;
    const name = (r.payment || '現金').trim() || '現金';
    let m = methods.find((x) => x.name === name);
    if (!m) {
      const type = LEGACY[name] || 'other';
      const canon = LEGACY[name] ? CANONICAL[type] : name;
      m = methods.find((x) => x.type === type && x.name === canon);
      if (!m) {
        m = { id: makeId(), name: canon, type, color: nextColor(methods) };
        methods.push(m);
        ids.add(m.id);
      }
    }
    r.paymentId = m.id;
    r.payment = m.name;
    changed = true;
  }
  return changed;
}

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・\-_()（）]/g, '');

/**
 * レシートから読み取った手がかりで、登録済みの支払方法を推定する。
 * @param {{type?:string, service?:string, brand?:string, last4?:string}} hint
 * @returns {{id:string, reason:string} | {type:string, candidates:string[], reason:string} | {type:string, missing:true, reason:string} | null}
 */
export function matchMethod(hint, methods) {
  if (!hint) return null;
  const active = methods.filter((m) => !m.archived);
  const one = (list) => (list.length === 1 ? list[0] : null);

  if (hint.last4) {
    const m = one(active.filter((x) => x.last4 === hint.last4));
    if (m) return { id: m.id, reason: `カード番号の下4桁「${hint.last4}」` };
  }
  if (hint.service) {
    const key = norm(hint.service);
    // 登録名に含まれる/登録名を含む、または以前に覚えたレシートの表示と似ている(OCR の崩れを許す)
    const hit = (x) => {
      const n = norm(x.name);
      if (n.includes(key) || (n.length >= 3 && key.includes(n))) return true;
      return (x.keywords || []).some((k) => { const nk = norm(k); return nk === key || (key.length >= 4 && similarity(nk, key) > 0.6); });
    };
    const m = one(active.filter(hit));
    if (m) return { id: m.id, reason: `「${hint.service}」の表示` };
  }
  const type = hint.type || (hint.brand ? 'credit' : null);
  if (hint.brand && (!type || isCardType(type))) {
    const m = one(active.filter((x) => isCardType(x.type) && x.brand === hint.brand));
    if (m) return { id: m.id, reason: `「${hint.brand}」の表示` };
  }
  if (type) {
    const sameType = active.filter((x) => x.type === type);
    const label = hint.service || hint.brand || typeLabel(type);
    if (sameType.length === 1) return { id: sameType[0].id, reason: `「${label}」の表示` };
    if (sameType.length > 1) {
      // ブランドが分かっていれば、そのブランドのカードに候補を絞る
      const byBrand = hint.brand ? sameType.filter((x) => x.brand === hint.brand) : [];
      const cands = byBrand.length ? byBrand : sameType;
      return { type, candidates: cands.map((x) => x.id), reason: `「${label}」の表示` };
    }
    return { type, missing: true, reason: `「${label}」の表示` };
  }
  return null;
}

/**
 * 支払方法別の集計。種類ごとにまとめ、金額の大きい順に並べる。
 * @returns {{type:string, label:string, total:number, count:number, methods:{method:object, total:number, count:number}[]}[]}
 */
export function summarizeByMethod(records, methods) {
  const byId = new Map(methods.map((m) => [m.id, m]));
  const perMethod = new Map();
  for (const r of records) {
    const m = byId.get(r.paymentId) || { id: r.paymentId || '_unknown', name: r.payment || '不明', type: 'other', color: '#879290' };
    const cur = perMethod.get(m.id) || { method: m, total: 0, count: 0 };
    cur.total += r.total || 0;
    cur.count++;
    perMethod.set(m.id, cur);
  }
  const groups = new Map();
  for (const v of perMethod.values()) {
    const t = v.method.type;
    const g = groups.get(t) || { type: t, label: typeLabel(t), total: 0, count: 0, methods: [] };
    g.total += v.total;
    g.count += v.count;
    g.methods.push(v);
    groups.set(t, g);
  }
  const out = [...groups.values()].sort((a, b) => b.total - a.total);
  out.forEach((g) => g.methods.sort((a, b) => b.total - a.total));
  return out;
}
