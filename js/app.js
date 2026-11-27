import { LiveScanner, prepareOCR } from './scanner.js';
import { guessCategory } from './parser.js';

// ---- 定数 -------------------------------------------------------------
const CATEGORIES = [
  { name: '食費', color: '#e0843a' },
  { name: '外食', color: '#d0587a' },
  { name: '日用品', color: '#33978a' },
  { name: '交通', color: '#4a78d6' },
  { name: '医療', color: '#8b6ad0' },
  { name: '趣味・衣服', color: '#c49a1c' },
  { name: 'その他', color: '#879290' },
];
const catColor = (name) => (CATEGORIES.find((c) => c.name === name) || CATEGORIES[CATEGORIES.length - 1]).color;
const STORAGE_KEY = 'receipt-kakeibo:v1';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const $ = (id) => document.getElementById(id);
const yen = (n) => `¥${Math.round(n || 0).toLocaleString('ja-JP')}`;
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const toInt = (s) => {
  const t = String(s ?? '').normalize('NFKC').replace(/[^\d-]/g, '');
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
};
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// ---- 保存 -------------------------------------------------------------
const store = {
  list: [],
  load() {
    try { this.list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
  },
  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list)); return true; } catch (e) {
      toast('保存できませんでした。ブラウザの保存領域を確認してください。');
      return false;
    }
  },
  upsert(r) {
    const i = this.list.findIndex((x) => x.id === r.id);
    if (i >= 0) this.list[i] = r; else this.list.push(r);
    return this.save();
  },
  remove(id) { this.list = this.list.filter((x) => x.id !== id); this.save(); },
};

// ---- 画面状態 -----------------------------------------------------------
const now = new Date();
let month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  render();
}

function render() {
  const [y, m] = month.split('-').map(Number);
  $('month-label').textContent = `${y}年${m}月`;
  const cur = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  $('next-month').disabled = month >= cur;
  $('sum-label').textContent = month === cur ? '今月の支出' : `${m}月の支出`;

  const rows = store.list.filter((r) => (r.date || '').startsWith(month)).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const total = rows.reduce((a, r) => a + (r.total || 0), 0);
  $('sum-total').textContent = Math.round(total).toLocaleString('ja-JP');
  const days = month === cur ? now.getDate() : new Date(y, m, 0).getDate();
  $('sum-sub').textContent = rows.length ? `レシート ${rows.length}枚 ・ 1日あたり ${yen(total / days)}` : 'まだ記録がありません';

  // カテゴリ別
  const byCat = new Map();
  rows.forEach((r) => byCat.set(r.category || 'その他', (byCat.get(r.category || 'その他') || 0) + (r.total || 0)));
  const cats = [...byCat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const bar = $('catbar');
  bar.replaceChildren(...cats.map(([c, v]) => el('span', { style: `flex:${v};background:${catColor(c)}`, title: `${c} ${yen(v)}` })));
  bar.setAttribute('aria-label', cats.map(([c, v]) => `${c} ${yen(v)}`).join('、') || '記録なし');
  $('catlist').replaceChildren(...cats.map(([c, v]) => el('li', {},
    el('span', { class: 'dot', style: `background:${catColor(c)}` }),
    el('span', { class: 'name' }, `${c} `, el('small', { style: 'color:var(--ink-2)' }, `${Math.round((v / total) * 100)}%`)),
    el('span', { class: 'amt' }, yen(v)))));

  // 履歴(日ごと)
  const groups = new Map();
  rows.forEach((r) => { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(r); });
  const hist = $('history');
  hist.replaceChildren(...[...groups].map(([date, list]) => {
    const d = new Date(`${date}T00:00:00`);
    return el('div', { class: 'day' },
      el('div', { class: 'day-head' },
        el('span', {}, `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`),
        el('span', { class: 'day-total' }, yen(list.reduce((a, r) => a + (r.total || 0), 0)))),
      el('div', { class: 'entries' }, list.map((r) => el('button', { class: 'entry', type: 'button', onclick: () => openEditor(r) },
        el('span', { class: 'entry-mark', style: `background:${catColor(r.category)}` }),
        el('span', { class: 'entry-main' },
          el('div', { class: 'entry-store' }, r.store || '(店名なし)', r.demo ? el('span', { class: 'demo-tag' }, 'お試し') : null),
          el('div', { class: 'entry-meta' }, [r.category, r.items?.length ? `${r.items.length}品` : null, r.payment, r.memo].filter(Boolean).join(' ・ '))),
        el('span', { class: 'entry-amount' }, yen(r.total))))));
  }));
  $('empty').hidden = rows.length > 0;
}

// ---- 編集シート ---------------------------------------------------------
let editing = null; // 編集中の記録
let scanInfo = null; // 読み取り結果から開いたときの補足

function buildCategoryChips() {
  const fs = $('f-cats');
  CATEGORIES.forEach((c, i) => {
    fs.append(el('label', { class: 'chip', style: `--c:${c.color}` },
      el('input', { type: 'radio', name: 'cat', value: c.name, id: `f-cat-${i}` }),
      el('span', {}, c.name)));
  });
}

function itemRow(item = { name: '', price: '' }, tentative = false) {
  const li = el('li', { class: tentative ? 'tentative' : '' });
  const name = el('input', { type: 'text', class: 'name', value: item.name ?? '', placeholder: '品名', 'aria-label': '品名', autocomplete: 'off' });
  const price = el('input', { type: 'text', class: 'price', inputmode: 'numeric', value: item.price === '' || item.price == null ? '' : String(item.price), placeholder: '0', 'aria-label': '金額', autocomplete: 'off' });
  const del = el('button', { type: 'button', class: 'del', 'aria-label': 'この行を削除' });
  del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  del.addEventListener('click', () => { li.remove(); syncTotalHint(); ensureItemsPlaceholder(); });
  const onPrice = () => { li.classList.toggle('neg', toInt(price.value) < 0); syncTotalHint(true); };
  price.addEventListener('input', onPrice);
  name.addEventListener('input', () => li.classList.remove('tentative'));
  li.append(name, price, del);
  li.classList.toggle('neg', toInt(item.price) < 0);
  return li;
}

function ensureItemsPlaceholder() {
  const ul = $('f-items');
  const hasRows = ul.querySelector('li:not(.none)');
  const ph = ul.querySelector('li.none');
  if (!hasRows && !ph) ul.append(el('li', { class: 'none' }, '品目なし(合計だけでも保存できます)'));
  if (hasRows && ph) ph.remove();
}

function itemsFromForm() {
  return [...$('f-items').querySelectorAll('li:not(.none)')].map((li) => ({
    name: li.querySelector('.name').value.trim(),
    price: toInt(li.querySelector('.price').value),
  })).filter((x) => x.name || x.price);
}

let totalTouched = false;
function syncTotalHint(fromItems = false) {
  const items = itemsFromForm();
  const sum = items.reduce((a, x) => a + x.price, 0);
  const totalInput = $('f-total');
  if (fromItems && !totalTouched && items.length) totalInput.value = String(sum);
  const total = toInt(totalInput.value);
  const hint = $('f-total-hint');
  if (!items.length) { hint.textContent = ''; hint.classList.remove('mismatch'); return; }
  const tax = scanInfo?.taxOut;
  if (sum === total) { hint.textContent = `品目の合計 ${yen(sum)} と一致しています`; hint.classList.remove('mismatch'); }
  else if (tax != null && sum + tax === total) { hint.textContent = `品目 ${yen(sum)} + 外税 ${yen(tax)} = 合計`; hint.classList.remove('mismatch'); }
  else { hint.textContent = `品目の合計は ${yen(sum)}(差額 ${yen(total - sum)})`; hint.classList.add('mismatch'); }
}

function openEditor(record, info = null) {
  editing = record ? { ...record } : null;
  scanInfo = info;
  totalTouched = !!(record && record.id) || (info && info.total != null);
  const r = record || {};
  $('editor-title').textContent = info ? 'レシートの確認' : r.id ? '記録の編集' : '手入力で記録';
  $('f-store').value = r.store || '';
  $('f-date').value = r.date || todayStr();
  $('f-pay').value = r.payment || '現金';
  const cat = r.category || 'その他';
  document.querySelectorAll('#f-cats input').forEach((i) => { i.checked = i.value === cat; });
  const ul = $('f-items');
  ul.replaceChildren(...(r.items || []).map((it) => itemRow({ name: it.name, price: it.price }, !!it.adjusted)));
  ensureItemsPlaceholder();
  $('f-total').value = r.total != null ? String(r.total) : '';
  $('f-memo').value = r.memo || '';

  // 読み取り結果のチェック表示
  const check = $('f-check');
  if (info) {
    check.hidden = false;
    const sum = (r.items || []).reduce((a, x) => a + x.price, 0);
    if (info.match) {
      check.className = 'check ok';
      check.replaceChildren(el('span', { class: 'mini-stamp' }, '合計', el('br'), '一致'),
        el('p', {}, `品目の合計がレシートの合計 ${yen(info.total)} と一致しました。`,
          info.reconciled ? '読み違いの可能性がある1行を合計に合わせて直しています(色の付いた行)。' : '内容を確認して保存してください。'));
    } else if (info.total != null) {
      check.className = 'check warn';
      check.replaceChildren(el('p', {}, `品目の合計 ${yen(sum)} とレシートの合計 ${yen(info.total)} が ${yen(Math.abs(info.total - sum))} ずれています。抜けている品目がないか確認してください。`));
    } else {
      check.className = 'check warn';
      check.replaceChildren(el('p', {}, 'レシートの「合計」の行が読み取れませんでした。合計金額を確認してください。'));
    }
  } else check.hidden = true;

  // 候補(1回しか見えなかった行)
  const cands = info?.candidates || [];
  $('f-cands').hidden = !cands.length;
  $('f-cands-n').textContent = String(cands.length);
  $('f-cands-list').replaceChildren(...cands.map((c) => {
    const li = el('li', {}, el('span', {}, c.name), el('span', { class: 'p' }, yen(c.price)));
    li.append(el('button', { type: 'button', onclick: () => { $('f-items').append(itemRow(c)); ensureItemsPlaceholder(); li.remove(); syncTotalHint(true); } }, '追加'));
    return li;
  }));
  $('f-cands').open = false;

  $('f-delete').hidden = !(r.id);
  $('f-confirm-del').hidden = true;
  syncTotalHint();
  $('editor').showModal();
  if (!info && !r.id) setTimeout(() => $('f-store').focus(), 50);
}

function closeEditor() { $('editor').close(); }

function saveEditor(e) {
  e.preventDefault();
  const items = itemsFromForm();
  let total = toInt($('f-total').value);
  if (!total && items.length) total = items.reduce((a, x) => a + x.price, 0);
  if (!total) { toast('合計金額を入れてください'); $('f-total').focus(); return; }
  const date = $('f-date').value || todayStr();
  const rec = {
    id: editing?.id || uid(),
    createdAt: editing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    date,
    store: $('f-store').value.trim(),
    category: document.querySelector('#f-cats input:checked')?.value || 'その他',
    payment: $('f-pay').value,
    items,
    total,
    memo: $('f-memo').value.trim(),
    source: editing?.source || (scanInfo ? 'scan' : 'manual'),
    demo: editing?.demo || undefined,
  };
  if (!store.upsert(rec)) return;
  closeEditor();
  month = date.slice(0, 7);
  render();
  toast(scanInfo ? `${yen(total)} を記録しました` : '保存しました');
}

// ---- 読み取り画面 ---------------------------------------------------------
let scanner = null;
let lastSnap = null;
let shownIds = new Set();
let wakeLock = null;
let matchedOnce = false;

async function openScan() {
  const sec = $('scan');
  sec.hidden = false;
  document.body.style.overflow = 'hidden';
  $('scan-error').hidden = true;
  $('ocr-loading').hidden = true;
  $('scan-status').textContent = 'カメラを準備しています';
  shownIds = new Set();
  matchedOnce = false;
  $('scan-hint').hidden = false;
  renderTape(null);

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return scanError('カメラは https:// で公開したページ(またはこの端末の localhost)でしか使えません。GitHub Pages などの https のアドレスで開いてください。');
  }
  scanner = new LiveScanner({
    video: $('video'),
    overlay: $('overlay'),
    onUpdate: (snap) => renderTape(snap),
    onStatus: onScanStatus,
  });
  try {
    await scanner.start();
  } catch (e) {
    scanner = null;
    const msg = e && e.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザの設定でこのサイトのカメラを「許可」にしてから、もう一度お試しください。'
      : e && e.name === 'NotFoundError' ? 'この端末でカメラが見つかりませんでした。'
        : `カメラを起動できませんでした(${e?.name || e})。`;
    return scanError(msg);
  }
  try { localStorage.setItem('receipt-kakeibo:ocr-used', '1'); } catch { /* 無視 */ }
  $('torch').hidden = !scanner.torchSupported;
  $('torch').setAttribute('aria-pressed', 'false');
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}

function scanError(text) {
  $('scan-error-text').textContent = text;
  $('scan-error').hidden = false;
  $('scan-status').textContent = '停止中';
}

function closeScan() {
  if (scanner) scanner.stop();
  scanner = null;
  try { wakeLock?.release(); } catch { /* 無視 */ }
  wakeLock = null;
  $('scan').hidden = true;
  $('scan').classList.remove('is-scanning');
  document.body.style.overflow = '';
}

function onScanStatus(s) {
  const pill = $('scan-status');
  if (s.phase === 'loading') {
    $('ocr-loading').hidden = false;
    pill.textContent = '準備中';
    const p = s.status && s.status.includes('traineddata') ? 0.3 + s.progress * 0.6 : s.status && s.status.includes('core') ? s.progress * 0.3 : 0.9 + s.progress * 0.1;
    $('ocr-progress').style.width = `${Math.round(Math.min(1, p) * 100)}%`;
  } else if (s.phase === 'scanning') {
    $('ocr-loading').hidden = true;
    $('scan').classList.add('is-scanning');
    if (s.hint === 'blur') { pill.replaceChildren('ぶれています。少し止めてください'); return; }
    const parts = [el('span', { class: 'live' }), '読み取り中'];
    if (s.ms) parts.push(` ・ ${(s.ms / 1000).toFixed(1)}秒/回`);
    pill.replaceChildren(...parts);
  } else if (s.phase === 'error') {
    $('ocr-loading').hidden = true;
    scanError(`文字認識エンジンを読み込めませんでした: ${s.message}`);
  }
}

function renderTape(snap) {
  lastSnap = snap;
  const ol = $('tape-items');
  if (!snap || !snap.items.length) {
    ol.replaceChildren(el('li', { class: 'placeholder' }, '読み取った品目がここに印字されます'));
    $('tape-store').textContent = snap?.store || '店名を探しています';
    $('tape-date').textContent = snap?.date ? fmtDate(snap.date) : '';
    $('tape-sum').textContent = '¥0';
    $('tape-total').textContent = snap?.total != null ? yen(snap.total) : '—';
    $('tape-stamp').hidden = true;
    $('scan-done').disabled = !(snap && (snap.total != null));
    return;
  }
  $('tape-store').textContent = snap.store || '店名(読み取れず)';
  $('tape-date').textContent = snap.date ? fmtDate(snap.date) : '';
  const items = snap.items.filter((x) => x.confirmed || x.hits >= 1);
  let newConfirmed = false;
  ol.replaceChildren(...items.map((it) => {
    const fresh = it.confirmed && !shownIds.has(it.id);
    if (fresh) { shownIds.add(it.id); newConfirmed = true; }
    return el('li', { class: [it.confirmed ? '' : 'tentative', fresh ? 'fresh' : '', it.price < 0 ? 'discount' : '', it.adjusted ? 'adjusted' : ''].join(' ') },
      el('span', { class: 'n' }, it.name), el('span', { class: 'p' }, it.price < 0 ? `-${yen(-it.price)}` : yen(it.price)));
  }));
  $('scan-hint').hidden = items.some((x) => x.confirmed);
  if (newConfirmed) {
    const last = ol.querySelector('li.fresh:last-of-type') || ol.lastElementChild;
    last?.scrollIntoView({ block: 'nearest' });
    try { navigator.vibrate?.(15); } catch { /* 非対応 */ }
  }
  $('tape-sum').textContent = yen(snap.sum);
  $('tape-total').textContent = snap.total != null ? yen(snap.total) : '—';
  $('tape-stamp').hidden = !snap.match;
  if (snap.match && !matchedOnce) {
    matchedOnce = true;
    try { navigator.vibrate?.([30, 60, 30]); } catch { /* 非対応 */ }
  }
  $('scan-done').disabled = false;
}

function fmtDate(s) {
  const d = new Date(`${s}T00:00:00`);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${WEEK[d.getDay()]})`;
}

function finishScan() {
  const snap = lastSnap;
  closeScan();
  if (!snap) return;
  const confirmed = snap.items.filter((x) => x.confirmed).map((x) => ({ name: x.name, price: x.price, adjusted: x.adjusted }));
  const candidates = snap.items.filter((x) => !x.confirmed).map((x) => ({ name: x.name, price: x.price }));
  const total = snap.total ?? (confirmed.length ? snap.sum : null);
  const record = {
    store: snap.store || '',
    date: snap.date || todayStr(),
    payment: snap.payment || '現金',
    category: guessCategory(snap.store, confirmed) || '食費',
    items: confirmed,
    total,
  };
  openEditor(record, { match: snap.match, total: snap.total, taxOut: snap.taxOut, candidates, reconciled: !!snap.reconciled });
}

// ---- 設定・データ ---------------------------------------------------------
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportCSV() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['日付', '店名', 'カテゴリ', '支払い', '品名', '金額', 'レシート合計', 'メモ'].map(q).join(',')];
  [...store.list].sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => {
    const items = r.items?.length ? r.items : [{ name: '', price: '' }];
    items.forEach((it, i) => rows.push([r.date, r.store, r.category, r.payment, it.name, it.price, i === 0 ? r.total : '', i === 0 ? r.memo : ''].map(q).join(',')));
  });
  download(`kakeibo-${todayStr()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function exportJSON() {
  download(`kakeibo-backup-${todayStr()}.json`, JSON.stringify({ app: 'receipt-kakeibo', version: 1, records: store.list }, null, 1), 'application/json');
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const recs = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(recs)) throw new Error('形式が違います');
    let added = 0;
    for (const r of recs) {
      if (!r || typeof r !== 'object' || !r.date || r.total == null) continue;
      const clean = {
        id: String(r.id || uid()), createdAt: String(r.createdAt || new Date().toISOString()), date: String(r.date).slice(0, 10),
        store: String(r.store || ''), category: CATEGORIES.some((c) => c.name === r.category) ? r.category : 'その他',
        payment: String(r.payment || '現金'), total: toInt(r.total), memo: String(r.memo || ''), source: r.source === 'scan' ? 'scan' : 'manual',
        items: Array.isArray(r.items) ? r.items.map((x) => ({ name: String(x.name || ''), price: toInt(x.price) })) : [],
      };
      const i = store.list.findIndex((x) => x.id === clean.id);
      if (i >= 0) store.list[i] = clean; else { store.list.push(clean); added++; }
    }
    store.save();
    render();
    toast(`${recs.length}件を読み込みました(新規 ${added}件)`);
  } catch (e) {
    toast(`読み込めませんでした: ${e.message}`);
  }
}

function addDemo() {
  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() - offset); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const base = { createdAt: new Date().toISOString(), source: 'manual', demo: true, memo: '' };
  const demo = [
    { store: 'スーパーみどり 中央店', category: '食費', payment: '現金', date: d(0), items: [{ name: '牛乳 1000ml', price: 238 }, { name: '食パン 6枚切', price: 158 }, { name: 'たまご 10個入', price: 258 }, { name: 'バナナ', price: 198 }, { name: '鶏むね肉', price: 412 }, { name: '値引', price: -50 }, { name: 'キッチンペーパー', price: 298 }], total: 1512 },
    { store: 'ファミリーストア 駅前店', category: '食費', payment: '電子マネー', date: d(1), items: [{ name: 'おにぎり 鮭', price: 160 }, { name: '緑茶 500ml', price: 151 }], total: 311 },
    { store: '定食 さくら', category: '外食', payment: 'QR決済', date: d(1), items: [{ name: '日替わり定食', price: 980 }], total: 980 },
    { store: 'くすりのハナ 本町店', category: '日用品', payment: 'クレジット', date: d(3), items: [{ name: '洗濯洗剤', price: 598 }, { name: 'ティッシュ5箱', price: 398 }], total: 1095 },
    { store: '市営バス', category: '交通', payment: '電子マネー', date: d(4), items: [], total: 230 },
  ];
  demo.forEach((r) => store.list.push({ ...base, ...r, id: uid() }));
  store.save();
  render();
  toast('お試しデータを入れました。設定からまとめて消せます');
}

// ---- その他 -------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function bind() {
  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('start-scan').addEventListener('click', openScan);
  $('manual-add').addEventListener('click', () => openEditor(null));
  $('add-demo').addEventListener('click', addDemo);
  $('close-scan').addEventListener('click', closeScan);
  $('scan-error-close').addEventListener('click', closeScan);
  $('scan-reset').addEventListener('click', () => { shownIds = new Set(); matchedOnce = false; scanner?.reset(); });
  $('scan-done').addEventListener('click', finishScan);
  $('torch').addEventListener('click', async () => {
    const on = $('torch').getAttribute('aria-pressed') !== 'true';
    if (await scanner?.setTorch(on)) $('torch').setAttribute('aria-pressed', String(on));
  });
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && scanner && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 無視 */ } }
  });

  $('entry-form').addEventListener('submit', saveEditor);
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  $('f-add-item').addEventListener('click', () => {
    const li = itemRow();
    $('f-items').append(li);
    ensureItemsPlaceholder();
    li.querySelector('.name').focus();
  });
  $('f-total').addEventListener('input', () => { totalTouched = true; syncTotalHint(); });
  $('f-delete').addEventListener('click', () => { $('f-confirm-del').hidden = false; });
  $('f-del-cancel').addEventListener('click', () => { $('f-confirm-del').hidden = true; });
  $('f-del-ok').addEventListener('click', () => { store.remove(editing.id); closeEditor(); render(); toast('削除しました'); });

  $('open-settings').addEventListener('click', () => { $('clear-confirm').hidden = true; $('settings').showModal(); });
  $('export-csv').addEventListener('click', exportCSV);
  $('export-json').addEventListener('click', exportJSON);
  $('import-json').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ''; });
  $('clear-demo').addEventListener('click', () => {
    const n = store.list.filter((r) => r.demo).length;
    store.list = store.list.filter((r) => !r.demo); store.save(); render();
    toast(n ? `お試しデータ ${n}件を消しました` : 'お試しデータはありません');
  });
  $('clear-all').addEventListener('click', () => { $('clear-confirm').hidden = false; });
  $('clear-cancel').addEventListener('click', () => { $('clear-confirm').hidden = true; });
  $('clear-ok').addEventListener('click', () => { store.list = []; store.save(); render(); $('clear-confirm').hidden = true; $('settings').close(); toast('すべての記録を消しました'); });
}

// ---- 起動 -------------------------------------------------------------
store.load();
buildCategoryChips();
bind();
render();
try { navigator.storage?.persist?.(); } catch { /* 非対応 */ }
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 一度でも読み取りを使った端末では、すぐ始められるよう OCR エンジンを裏で準備しておく
let usedBefore = false;
try { usedBefore = localStorage.getItem('receipt-kakeibo:ocr-used') === '1'; } catch { /* 無視 */ }
if (usedBefore && window.isSecureContext) setTimeout(() => { prepareOCR().catch(() => {}); }, 1500);
