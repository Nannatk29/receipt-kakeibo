import { LiveScanner, prepareOCR } from './scanner.js';
import { guessCategory } from './parser.js';
import {
  PAYMENT_TYPES, BRANDS, NAME_SUGGESTIONS, METHOD_COLORS, typeLabel, isCardType,
  defaultMethods, migrateRecords, matchMethod, summarizeByMethod, methodLabel, nextColor,
} from './payments.js';

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
const METHODS_KEY = 'receipt-kakeibo:methods';
const PREF_KEY = 'receipt-kakeibo:prefs';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const $ = (id) => document.getElementById(id);
const yen = (n) => `${n < 0 ? '-' : ''}¥${Math.abs(Math.round(n || 0)).toLocaleString('ja-JP')}`;
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
const icon = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};

// ---- 保存 -------------------------------------------------------------
function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch {
    toast('保存できませんでした。ブラウザの保存領域を確認してください。');
    return false;
  }
}

const store = {
  list: [],
  load() { this.list = readJSON(STORAGE_KEY, []); if (!Array.isArray(this.list)) this.list = []; },
  save() { return writeJSON(STORAGE_KEY, this.list); },
  upsert(r) {
    const i = this.list.findIndex((x) => x.id === r.id);
    if (i >= 0) this.list[i] = r; else this.list.push(r);
    return this.save();
  },
  remove(id) { this.list = this.list.filter((x) => x.id !== id); this.save(); },
};

const methods = {
  list: [],
  load() {
    this.list = readJSON(METHODS_KEY, []);
    if (!Array.isArray(this.list) || !this.list.length) this.list = defaultMethods();
  },
  save() { return writeJSON(METHODS_KEY, this.list); },
  get(id) { return this.list.find((m) => m.id === id); },
  active() { return this.list.filter((m) => !m.archived); },
  usage(id) { return store.list.filter((r) => r.paymentId === id).length; },
};
const newMethodId = () => `pm_${uid()}`;

const prefs = {
  data: {},
  load() { this.data = readJSON(PREF_KEY, {}) || {}; },
  set(k, v) { this.data[k] = v; writeJSON(PREF_KEY, this.data); },
};

// ---- ホーム -------------------------------------------------------------
const now = new Date();
let month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
let filter = null; // { kind: 'cat' | 'method' | 'type', value }

function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  render();
}

function recordMethod(r) { return methods.get(r.paymentId); }
function matchesFilter(r) {
  if (!filter) return true;
  if (filter.kind === 'cat') return (r.category || 'その他') === filter.value;
  if (filter.kind === 'method') return r.paymentId === filter.value;
  if (filter.kind === 'type') return (recordMethod(r)?.type || 'other') === filter.value;
  return true;
}
function toggleFilter(kind, value) {
  filter = filter && filter.kind === kind && filter.value === value ? null : { kind, value };
  render();
  if (filter) $('hist-label').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  const view = prefs.data.view === 'pay' ? 'pay' : 'cat';
  $('tab-cat').setAttribute('aria-selected', String(view === 'cat'));
  $('tab-pay').setAttribute('aria-selected', String(view === 'pay'));
  $('catlist').hidden = view !== 'cat';
  $('paylist').hidden = view !== 'pay';
  if (view === 'cat') renderCategoryBreakdown(rows, total); else renderPaymentBreakdown(rows, total);
  $('breakdown-note').textContent = rows.length ? '項目をタップすると、その内訳の履歴だけを表示します' : '';

  // 絞り込み
  const shown = rows.filter(matchesFilter);
  const fb = $('filter-bar');
  fb.hidden = !filter;
  if (filter) {
    let name = filter.value, color = 'var(--ink-2)';
    if (filter.kind === 'cat') color = catColor(filter.value);
    if (filter.kind === 'method') { const pm = methods.get(filter.value); name = pm ? methodLabel(pm) : '(削除した支払方法)'; color = pm?.color || color; }
    if (filter.kind === 'type') name = `${typeLabel(filter.value)}(すべて)`;
    $('filter-name').textContent = name;
    $('filter-dot').style.background = color;
    $('filter-sum').textContent = `${yen(shown.reduce((a, r) => a + (r.total || 0), 0))} ・ ${shown.length}件`;
  }

  // 履歴(日ごと)
  const groups = new Map();
  shown.forEach((r) => { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(r); });
  $('history').replaceChildren(...[...groups].map(([date, list]) => {
    const d = new Date(`${date}T00:00:00`);
    return el('div', { class: 'day' },
      el('div', { class: 'day-head' },
        el('span', {}, `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`),
        el('span', { class: 'day-total' }, yen(list.reduce((a, r) => a + (r.total || 0), 0)))),
      el('div', { class: 'entries' }, list.map((r) => {
        const pm = recordMethod(r);
        return el('button', { class: 'entry', type: 'button', onclick: () => openEditor(r) },
          el('span', { class: 'entry-mark', style: `background:${catColor(r.category)}` }),
          el('span', { class: 'entry-main' },
            el('div', { class: 'entry-store' }, r.store || '(店名なし)', r.demo ? el('span', { class: 'demo-tag' }, 'お試し') : null),
            el('div', { class: 'entry-meta' }, [r.category, r.items?.length ? `${r.items.length}品` : null, pm ? methodLabel(pm) : r.payment, r.memo].filter(Boolean).join(' ・ '))),
          el('span', { class: 'entry-amount' }, yen(r.total)));
      })));
  }));
  $('empty').hidden = rows.length > 0;
  $('empty-filter').hidden = !(filter && rows.length && !shown.length);
}

function renderCategoryBreakdown(rows, total) {
  const byCat = new Map();
  rows.forEach((r) => byCat.set(r.category || 'その他', (byCat.get(r.category || 'その他') || 0) + (r.total || 0)));
  const cats = [...byCat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const bar = $('catbar');
  bar.replaceChildren(...cats.map(([c, v]) => el('span', { style: `flex:${v};background:${catColor(c)}`, title: `${c} ${yen(v)}` })));
  bar.setAttribute('aria-label', cats.map(([c, v]) => `${c} ${yen(v)}`).join('、') || '記録なし');
  $('catlist').replaceChildren(...cats.map(([c, v]) => el('li', {},
    el('button', { type: 'button', class: 'row', 'aria-pressed': String(!!(filter && filter.kind === 'cat' && filter.value === c)), onclick: () => toggleFilter('cat', c) },
      el('span', { class: 'dot', style: `background:${catColor(c)}` }),
      el('span', { class: 'name' }, `${c} `, el('small', { style: 'color:var(--ink-2)' }, `${Math.round((v / total) * 100)}%`)),
      el('span', { class: 'amt' }, yen(v))))));
}

function renderPaymentBreakdown(rows, total) {
  const groups = summarizeByMethod(rows, methods.list);
  const flat = groups.flatMap((g) => g.methods);
  const bar = $('catbar');
  bar.replaceChildren(...flat.filter((x) => x.total > 0).map((x) => el('span', { style: `flex:${x.total};background:${x.method.color}`, title: `${methodLabel(x.method)} ${yen(x.total)}` })));
  bar.setAttribute('aria-label', flat.map((x) => `${methodLabel(x.method)} ${yen(x.total)}`).join('、') || '記録なし');
  const pct = (v) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '');
  const pressed = (kind, value) => String(!!(filter && filter.kind === kind && filter.value === value));
  const methodRow = (x, sub) => el('button', { type: 'button', class: `pay-row${sub ? ' sub' : ''}`, 'aria-pressed': pressed('method', x.method.id), onclick: () => toggleFilter('method', x.method.id) },
    el('span', { class: 'dot', style: `background:${x.method.color}` }),
    el('span', { class: 'name' }, x.method.name,
      x.method.last4 ? el('span', { class: 'l4' }, `••${x.method.last4}`) : null,
      sub ? null : el('span', { class: 'kind' }, x.method.name === typeLabel(x.method.type) ? pct(x.total) : `${typeLabel(x.method.type)} ・ ${pct(x.total)}`)),
    el('span', { class: 'cnt' }, `${x.count}件`),
    el('span', { class: 'amt' }, yen(x.total)));
  $('paylist').replaceChildren(...groups.map((g) => {
    if (g.methods.length === 1) return el('li', { class: 'pay-group' }, methodRow(g.methods[0], false));
    return el('li', { class: 'pay-group' },
      el('button', { type: 'button', class: 'pay-row head', 'aria-pressed': pressed('type', g.type), onclick: () => toggleFilter('type', g.type) },
        el('span', { class: 'dot' }),
        el('span', { class: 'name' }, g.label, el('span', { class: 'kind' }, `${g.methods.length}種類 ・ ${pct(g.total)}`)),
        el('span', { class: 'cnt' }, `${g.count}件`),
        el('span', { class: 'amt' }, yen(g.total))),
      g.methods.map((x) => methodRow(x, true)));
  }));
}

// ---- 記録シート ---------------------------------------------------------
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

/** 支払方法の選択肢を描く */
function renderPayPicker(selectedId, suggestIds = []) {
  const box = $('f-pay');
  const list = methods.list.filter((m) => !m.archived || m.id === selectedId);
  box.replaceChildren(
    ...list.map((m) => el('label', { class: `chip${suggestIds.includes(m.id) ? ' suggest' : ''}`, style: `--c:${m.color}` },
      el('input', { type: 'radio', name: 'pay', value: m.id, id: `f-pay-${m.id}`, checked: m.id === selectedId }),
      el('span', {}, m.name, m.last4 ? el('small', { class: 'l4' }, `••${m.last4}`) : null))),
    el('button', { type: 'button', class: 'chip-add', onclick: () => openMethodEditor(null, { presetType: scanInfo?.payMatch?.type, fromEntry: true }) },
      list.length <= 1 ? '＋ カード・電子マネーを登録' : '＋ 追加'),
  );
}
function selectedPayId() { return document.querySelector('#f-pay input[name="pay"]:checked')?.value || null; }

/**
 * 自動で選べなかったとき、レシートの手がかり(カード番号の下4桁、または「TS3カード」などの表示)を
 * ユーザーが選んだ支払方法に覚えさせる。次回から自動で選ばれるようになる。
 */
function learnableCue() {
  const hint = scanInfo?.payHint;
  const m = methods.get(selectedPayId());
  if (!hint || !m || m.type === 'cash') return null;
  if (scanInfo?.payMatch?.id === m.id) return null; // すでに自動で選べている
  if (hint.last4 && isCardType(m.type) && !m.last4 && !methods.list.some((x) => x.last4 === hint.last4)) {
    return { kind: 'last4', value: hint.last4, m };
  }
  if (hint.service && !(m.keywords || []).includes(hint.service) && !m.name.includes(hint.service)) {
    return { kind: 'keyword', value: hint.service, m };
  }
  return null;
}
function syncLearn() {
  const t = learnableCue();
  $('f-learn-row').hidden = !t;
  if (!t) return;
  $('f-learn-text').textContent = t.kind === 'last4'
    ? `「${t.m.name}」にカード番号の下4桁「${t.value}」を登録する(次回からこのカードが自動で選ばれます)`
    : `レシートの「${t.value}」という表示を「${t.m.name}」として覚える(次回からこの支払方法が自動で選ばれます)`;
}
function setPayHint(text, kind = 'ok') {
  const h = $('f-pay-hint');
  h.hidden = !text;
  h.className = `pay-hint ${kind}`;
  h.textContent = text || '';
}

function itemRow(item = { name: '', price: '' }, tentative = false) {
  const li = el('li', { class: tentative ? 'tentative' : '' });
  const name = el('input', { type: 'text', class: 'name', value: item.name ?? '', placeholder: '品名', 'aria-label': '品名', autocomplete: 'off' });
  const price = el('input', { type: 'text', class: 'price', inputmode: 'numeric', value: item.price === '' || item.price == null ? '' : String(item.price), placeholder: '0', 'aria-label': '金額', autocomplete: 'off' });
  const del = el('button', { type: 'button', class: 'del', 'aria-label': 'この行を削除' }, icon('M6 6l12 12M18 6L6 18'));
  del.addEventListener('click', () => { li.remove(); syncTotalHint(); ensureItemsPlaceholder(); });
  price.addEventListener('input', () => { li.classList.toggle('neg', toInt(price.value) < 0); syncTotalHint(true); });
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

/** 新規の記録で最初に選んでおく支払方法 */
function defaultPayId() {
  const last = methods.get(prefs.data.lastPaymentId);
  if (last && !last.archived) return last.id;
  return methods.active()[0]?.id || null;
}

function openEditor(record, info = null) {
  editing = record ? { ...record } : null;
  scanInfo = info;
  totalTouched = !!(record && record.id) || (info && info.total != null);
  const r = record || {};
  $('editor-title').textContent = info ? 'レシートの確認' : r.id ? '記録の編集' : '手入力で記録';
  $('f-store').value = r.store || '';
  $('f-date').value = r.date || todayStr();
  const cat = r.category || 'その他';
  document.querySelectorAll('#f-cats input').forEach((i) => { i.checked = i.value === cat; });
  const ul = $('f-items');
  ul.replaceChildren(...(r.items || []).map((it) => itemRow({ name: it.name, price: it.price }, !!it.adjusted)));
  ensureItemsPlaceholder();
  $('f-total').value = r.total != null ? String(r.total) : '';
  $('f-memo').value = r.memo || '';

  // 支払方法
  $('f-pay-field').classList.remove('need');
  const pm = info?.payMatch;
  if (r.id) {
    renderPayPicker(r.paymentId);
    setPayHint('');
  } else if (pm && pm.id) {
    renderPayPicker(pm.id);
    setPayHint(`${pm.reason}から「${methodLabel(methods.get(pm.id))}」を選びました`, 'ok');
  } else if (pm && pm.candidates) {
    renderPayPicker(null, pm.candidates);
    setPayHint(`${pm.reason}から${typeLabel(pm.type)}払いと判断しました。どれで払ったか選んでください`, 'warn');
  } else if (pm && pm.missing) {
    renderPayPicker(null);
    setPayHint(`${pm.reason}から${typeLabel(pm.type)}払いのようですが、まだ登録されていません。「＋」から登録できます`, 'warn');
  } else {
    renderPayPicker(defaultPayId());
    setPayHint(info ? 'レシートから支払方法を判別できませんでした。前回の支払方法を選んでいます' : '', 'plain');
  }

  $('f-learn').checked = true;
  syncLearn();

  // 読み取り結果のチェック表示
  const check = $('f-check');
  if (info) {
    check.hidden = false;
    const sum = (r.items || []).reduce((a, x) => a + x.price, 0);
    const src = { payment: 'カード等の支払額', cash: 'お預りとお釣り', taxbase: '税率ごとの対象額' }[info.totalSource];
    const srcNote = src ? `(「合計」の行は読めなかったため、${src}から割り出しました)` : '';
    if (info.match) {
      check.className = 'check ok';
      check.replaceChildren(el('span', { class: 'mini-stamp' }, '合計', el('br'), '一致'),
        el('p', {}, `品目の合計がレシートの合計 ${yen(info.total)} と一致しました${srcNote}。`,
          info.reconciled ? '読み違いの可能性がある1行を合計に合わせて直しています(色の付いた行)。' : '内容を確認して保存してください。'));
    } else if (info.total != null) {
      check.className = 'check warn';
      check.replaceChildren(el('p', {}, `品目の合計 ${yen(sum)} とレシートの合計 ${yen(info.total)}${srcNote} が ${yen(Math.abs(info.total - sum))} ずれています。抜けている品目や金額の読み違いがないか確認してください。`));
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
  $('editor').querySelector('.sheet-body').scrollTop = 0;
  if (!info && !r.id) setTimeout(() => $('f-store').focus(), 50);
}

function closeEditor() { $('editor').close(); }

function saveEditor(e) {
  e.preventDefault();
  const items = itemsFromForm();
  let total = toInt($('f-total').value);
  if (!total && items.length) total = items.reduce((a, x) => a + x.price, 0);
  if (!total) { toast('合計金額を入れてください'); $('f-total').focus(); return; }
  const payId = selectedPayId();
  if (!payId) {
    $('f-pay-field').classList.add('need');
    $('f-pay-field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('支払方法を選んでください');
    return;
  }
  const pm = methods.get(payId);
  const date = $('f-date').value || todayStr();
  const rec = {
    id: editing?.id || uid(),
    createdAt: editing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    date,
    store: $('f-store').value.trim(),
    category: document.querySelector('#f-cats input:checked')?.value || 'その他',
    paymentId: payId,
    payment: pm?.name || '',
    items,
    total,
    memo: $('f-memo').value.trim(),
    source: editing?.source || (scanInfo ? 'scan' : 'manual'),
    demo: editing?.demo || undefined,
  };
  const learn = learnableCue();
  if (learn && $('f-learn').checked) {
    if (learn.kind === 'last4') learn.m.last4 = learn.value;
    else learn.m.keywords = [...(learn.m.keywords || []), learn.value].slice(-10);
    methods.save();
  }
  if (!store.upsert(rec)) return;
  prefs.set('lastPaymentId', payId);
  closeEditor();
  month = date.slice(0, 7);
  render();
  toast(scanInfo ? `${yen(total)} を記録しました` : '保存しました');
}

// ---- 支払方法の管理 -------------------------------------------------------
let methodEditing = null;
let methodFromEntry = false;

function openMethods() {
  renderMethodList();
  if ($('settings').open) $('settings').close();
  $('methods').showModal();
}

function renderMethodList() {
  const list = methods.list;
  $('methods-list').replaceChildren(...list.map((m, i) => {
    const n = methods.usage(m.id);
    const card = [m.brand, m.last4 ? `••${m.last4}` : null].filter(Boolean).join(' ');
    const sub = [typeLabel(m.type), card || null, `${n}件`, m.archived ? '非表示' : null].filter(Boolean).join(' ・ ');
    return el('li', { class: m.archived ? 'archived' : '' },
      el('span', { class: 'dot', style: `background:${m.color}` }),
      el('span', { class: 'info' }, el('div', { class: 'nm' }, m.name), el('div', { class: 'sub' }, sub)),
      el('span', { class: 'order' },
        el('button', { type: 'button', 'aria-label': `${m.name} を上へ`, disabled: i === 0, onclick: () => moveMethod(i, -1) }, icon('M6 15l6-6 6 6')),
        el('button', { type: 'button', 'aria-label': `${m.name} を下へ`, disabled: i === list.length - 1, onclick: () => moveMethod(i, 1) }, icon('M6 9l6 6 6-6'))),
      el('button', { type: 'button', class: 'edit', onclick: () => openMethodEditor(m) }, '編集'));
  }));
  const active = methods.active().length;
  $('methods-summary').textContent = `${methods.list.length}件登録(選択肢に表示 ${active}件)。記録のときにこの中から選びます。`;
}

function moveMethod(i, d) {
  const l = methods.list;
  const j = i + d;
  if (j < 0 || j >= l.length) return;
  [l[i], l[j]] = [l[j], l[i]];
  methods.save();
  renderMethodList();
}

function buildMethodEditorStatic() {
  $('m-types').replaceChildren(...PAYMENT_TYPES.map((t) => el('label', { class: 'chip plain' },
    el('input', { type: 'radio', name: 'mtype', value: t.key, id: `m-type-${t.key}` }),
    el('span', {}, t.label))));
  $('m-colors').replaceChildren(...METHOD_COLORS.map((c, i) => el('label', { class: 'swatch', style: `--c:${c}` },
    el('input', { type: 'radio', name: 'mcolor', value: c, id: `m-color-${i}`, 'aria-label': `色 ${i + 1}` }),
    el('span', {}))));
  BRANDS.forEach((b) => $('m-brand').append(el('option', { value: b }, b)));
  $('m-types').addEventListener('change', onMethodTypeChange);
}

function currentMethodType() { return document.querySelector('#m-types input:checked')?.value || 'credit'; }

function onMethodTypeChange() {
  const type = currentMethodType();
  const t = PAYMENT_TYPES.find((x) => x.key === type);
  $('m-name').placeholder = t?.namePlaceholder || '';
  $('m-card-fields').hidden = !isCardType(type);
  const sugg = NAME_SUGGESTIONS[type] || [];
  const used = new Set(methods.list.map((m) => m.name));
  const avail = sugg.filter((s) => !used.has(s));
  $('m-suggest').hidden = !avail.length;
  $('m-suggest').replaceChildren(...avail.map((s) => el('button', { type: 'button', onclick: () => { $('m-name').value = s; } }, s)));
}

function openMethodEditor(m, { presetType = null, fromEntry = false } = {}) {
  methodEditing = m;
  methodFromEntry = fromEntry;
  $('method-editor-title').textContent = m ? '支払方法を編集' : '支払方法を追加';
  const type = m?.type || presetType || 'credit';
  document.querySelectorAll('#m-types input').forEach((i) => { i.checked = i.value === type; });
  $('m-name').value = m?.name || '';
  $('m-brand').value = m?.brand || '';
  $('m-last4').value = m?.last4 || '';
  const color = m?.color || nextColor(methods.list);
  document.querySelectorAll('#m-colors input').forEach((i) => { i.checked = i.value === color; });
  $('m-archived').checked = !!m?.archived;
  renderKeywordChips(m);
  $('m-archive-row').hidden = !m;
  const n = m ? methods.usage(m.id) : 0;
  const isLast = m && methods.active().length === 1 && !m.archived;
  $('m-delete').hidden = !m || n > 0 || isLast;
  $('m-delete-note').hidden = !m || (!n && !isLast);
  $('m-delete-note').textContent = isLast ? '支払方法は最低1つ必要です。' : n ? `この支払方法の記録が ${n}件あるため削除できません。使わなくなった場合は「選択肢に表示しない」にしてください。` : '';
  $('m-confirm-del').hidden = true;
  onMethodTypeChange();
  $('method-editor').showModal();
  if (!m) setTimeout(() => $('m-name').focus(), 50);
}

let editingKeywords = [];
function renderKeywordChips(m) {
  if (m !== undefined) editingKeywords = [...(m?.keywords || [])];
  $('m-keywords-row').hidden = !editingKeywords.length;
  $('m-keywords').replaceChildren(...editingKeywords.map((k, i) => el('span', {}, k,
    el('button', { type: 'button', 'aria-label': `「${k}」を忘れる`, onclick: () => { editingKeywords.splice(i, 1); renderKeywordChips(); } }, icon('M6 6l12 12M18 6L6 18')))));
}

function saveMethod(e) {
  e.preventDefault();
  const name = $('m-name').value.trim();
  if (!name) { toast('名前を入れてください'); $('m-name').focus(); return; }
  const type = currentMethodType();
  const last4 = isCardType(type) ? $('m-last4').value.normalize('NFKC').replace(/\D/g, '') : '';
  if (last4 && last4.length !== 4) { toast('下4桁は数字4つで入れてください'); $('m-last4').focus(); return; }
  if (last4 && methods.list.some((x) => x.last4 === last4 && x.id !== methodEditing?.id)) {
    toast(`下4桁 ${last4} は別のカードで登録済みです`); $('m-last4').focus(); return;
  }
  const data = {
    name,
    type,
    color: document.querySelector('#m-colors input:checked')?.value || nextColor(methods.list),
    brand: isCardType(type) ? $('m-brand').value || undefined : undefined,
    last4: last4 || undefined,
    archived: methodEditing ? $('m-archived').checked || undefined : undefined,
    keywords: editingKeywords.length ? [...editingKeywords] : undefined,
  };
  if (data.archived && !methods.list.some((x) => x.id !== methodEditing?.id && !x.archived)) {
    toast('表示する支払方法が1つもなくなるため、非表示にできません'); return;
  }
  let saved;
  if (methodEditing) {
    saved = Object.assign(methodEditing, data);
    for (const k of Object.keys(saved)) if (saved[k] === undefined) delete saved[k];
    // 記録に残している名前も更新する
    store.list.forEach((r) => { if (r.paymentId === saved.id) r.payment = saved.name; });
    store.save();
  } else {
    saved = { id: newMethodId(), ...data };
    for (const k of Object.keys(saved)) if (saved[k] === undefined) delete saved[k];
    methods.list.push(saved);
  }
  methods.save();
  $('method-editor').close();
  if ($('methods').open) renderMethodList();
  if ($('editor').open) {
    // 記録シートから追加したときは、その支払方法を選んだ状態に戻す
    const sel = methodFromEntry && !methodEditing ? saved.id : selectedPayId();
    renderPayPicker(sel);
    if (methodFromEntry && !methodEditing) { setPayHint(`「${methodLabel(saved)}」を登録して選びました`, 'ok'); $('f-pay-field').classList.remove('need'); }
    syncLearn();
  }
  render();
  toast(methodEditing ? '支払方法を更新しました' : `「${saved.name}」を登録しました`);
}

function deleteMethod() {
  if (!methodEditing || methods.usage(methodEditing.id)) return;
  methods.list = methods.list.filter((m) => m !== methodEditing);
  methods.save();
  if (prefs.data.lastPaymentId === methodEditing.id) prefs.set('lastPaymentId', null);
  $('method-editor').close();
  renderMethodList();
  render();
  toast('削除しました');
}

// ---- 読み取り画面 ---------------------------------------------------------
let scanner = null;
let lastSnap = null;
let shownIds = new Set();
let wakeLock = null;
let matchedOnce = false;
let scanDone = false;   // 合計と一致して読み取りを止めた状態
let autoStop = true;    // 「続けて読む」を押したら、やり直すまで自動では止めない

async function openScan() {
  const sec = $('scan');
  sec.hidden = false;
  document.body.style.overflow = 'hidden';
  $('scan-error').hidden = true;
  $('ocr-loading').hidden = true;
  $('scan-status').textContent = 'カメラを準備しています';
  shownIds = new Set();
  matchedOnce = false;
  resetDoneState();
  autoStop = true;
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
    if (scanDone) { pill.textContent = '読み取り完了'; return; }
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

/** テープに出す支払方法の表示 */
function tapePayText(hint) {
  if (!hint || !hint.type) return '';
  const m = matchMethod(hint, methods.list);
  const seen = [hint.service, hint.brand, hint.last4 ? `****${hint.last4}` : null].filter(Boolean).join(' ') || typeLabel(hint.type);
  if (m && m.id) return `支払い: ${seen} → ${methodLabel(methods.get(m.id))}`;
  if (m && m.candidates) return `支払い: ${seen}(確認画面でどれか選びます)`;
  return `支払い: ${seen}`;
}

function resetDoneState() {
  scanDone = false;
  if (scanner) scanner.paused = false;
  $('scan-resume').hidden = true;
  $('scan-done').classList.remove('ready');
}

/** 読み取りの状況を一言で示す(いつ終わったか分かるように) */
function tapeStatus(snap) {
  if (scanDone) return { cls: 'done', text: '読み取り完了。合計と一致しました' };
  if (!snap || (!snap.items.length && snap.total == null)) return { cls: '', text: 'レシートを枠に入れてください' };
  if (snap.total == null) return { cls: '', text: '「合計」の行を探しています(下の方も写してください)' };
  if (snap.match) {
    return snap.paymentHint?.type
      ? { cls: 'done', text: '合計と一致しました' }
      : { cls: 'done', text: '合計と一致。支払いの行も写すと支払方法を自動で選べます' };
  }
  const withTax = snap.taxOut != null ? snap.sum + snap.taxOut : snap.sum;
  const base = snap.taxOut != null && Math.abs(snap.total - withTax) < Math.abs(snap.total - snap.sum) ? withTax : snap.sum;
  const diff = snap.total - base;
  if (diff > 0) return { cls: 'warn', text: `あと ${yen(diff)} 分の品目が未読です。ゆっくり写してください` };
  return { cls: 'warn', text: `品目の合計が ${yen(-diff)} 多い(余分な行を読んだ可能性)` };
}

function renderTape(snap) {
  lastSnap = snap;
  // 合計と一致したら確定できることを示し、支払いの行まで読めたら読み取りを止めて完了を知らせる
  $('scan-done').classList.toggle('ready', !!snap?.match);
  if (snap?.match && snap.paymentHint?.type && autoStop && !scanDone && scanner) {
    scanDone = true;
    scanner.paused = true;
    $('scan').classList.remove('is-scanning');
    $('scan-status').textContent = '読み取り完了';
    $('scan-resume').hidden = false;
  }
  const st = tapeStatus(snap);
  $('tape-status').textContent = st.text;
  $('tape-status').className = `tape-status ${st.cls}`;
  const ol = $('tape-items');
  const payText = tapePayText(snap?.paymentHint);
  $('tape-pay').hidden = !payText;
  $('tape-pay').textContent = payText;
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
      el('span', { class: 'n' }, it.name), el('span', { class: 'p' }, yen(it.price)));
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
    category: guessCategory(snap.store, confirmed) || '食費',
    items: confirmed,
    total,
  };
  const payMatch = matchMethod(snap.paymentHint, methods.list);
  openEditor(record, { match: snap.match, total: snap.total, totalSource: snap.totalSource, taxOut: snap.taxOut, candidates, reconciled: !!snap.reconciled, payMatch, payHint: snap.paymentHint });
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
  const rows = [['日付', '店名', 'カテゴリ', '支払方法', '支払方法の種類', '品名', '金額', 'レシート合計', 'メモ'].map(q).join(',')];
  [...store.list].sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => {
    const pm = recordMethod(r);
    const items = r.items?.length ? r.items : [{ name: '', price: '' }];
    items.forEach((it, i) => rows.push([r.date, r.store, r.category, pm ? methodLabel(pm) : r.payment, pm ? typeLabel(pm.type) : '', it.name, it.price, i === 0 ? r.total : '', i === 0 ? r.memo : ''].map(q).join(',')));
  });
  download(`kakeibo-${todayStr()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function exportJSON() {
  download(`kakeibo-backup-${todayStr()}.json`, JSON.stringify({ app: 'receipt-kakeibo', version: 2, paymentMethods: methods.list, records: store.list }, null, 1), 'application/json');
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const recs = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(recs)) throw new Error('形式が違います');
    // 支払方法(version 2 以降)
    let addedMethods = 0;
    for (const m of Array.isArray(data.paymentMethods) ? data.paymentMethods : []) {
      if (!m || typeof m !== 'object' || !m.id || !m.name) continue;
      const clean = {
        id: String(m.id), name: String(m.name).slice(0, 30),
        type: PAYMENT_TYPES.some((t) => t.key === m.type) ? m.type : 'other',
        color: /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : nextColor(methods.list),
      };
      if (BRANDS.includes(m.brand)) clean.brand = m.brand;
      if (/^\d{4}$/.test(m.last4 || '')) clean.last4 = m.last4;
      if (m.archived) clean.archived = true;
      if (Array.isArray(m.keywords)) {
        const kw = m.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, 30)).slice(0, 10);
        if (kw.length) clean.keywords = kw;
      }
      const i = methods.list.findIndex((x) => x.id === clean.id);
      if (i >= 0) methods.list[i] = clean; else { methods.list.push(clean); addedMethods++; }
    }
    let added = 0;
    for (const r of recs) {
      if (!r || typeof r !== 'object' || !r.date || r.total == null) continue;
      const clean = {
        id: String(r.id || uid()), createdAt: String(r.createdAt || new Date().toISOString()), date: String(r.date).slice(0, 10),
        store: String(r.store || ''), category: CATEGORIES.some((c) => c.name === r.category) ? r.category : 'その他',
        paymentId: r.paymentId ? String(r.paymentId) : undefined, payment: String(r.payment || '現金'),
        total: toInt(r.total), memo: String(r.memo || ''), source: r.source === 'scan' ? 'scan' : 'manual',
        items: Array.isArray(r.items) ? r.items.map((x) => ({ name: String(x.name || ''), price: toInt(x.price) })) : [],
      };
      const i = store.list.findIndex((x) => x.id === clean.id);
      if (i >= 0) store.list[i] = clean; else { store.list.push(clean); added++; }
    }
    migrateRecords(store.list, methods.list, newMethodId);
    methods.save();
    store.save();
    render();
    toast(`${recs.length}件を読み込みました(新規 ${added}件${addedMethods ? `、支払方法 ${addedMethods}件` : ''})`);
  } catch (e) {
    toast(`読み込めませんでした: ${e.message}`);
  }
}

function addDemo() {
  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() - offset); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  // お試し用の支払方法(お試しデータを消すと一緒に消える)
  const demoMethods = [
    { key: 'cardA', name: 'メインカード(お試し)', type: 'credit', brand: 'VISA', last4: '0001' },
    { key: 'cardB', name: 'ネット用カード(お試し)', type: 'credit', brand: 'Mastercard' },
    { key: 'ic', name: '交通系IC(お試し)', type: 'emoney' },
    { key: 'qr', name: 'QR決済(お試し)', type: 'qr' },
  ];
  const ids = { cash: methods.list.find((m) => m.type === 'cash')?.id || methods.active()[0].id };
  for (const dm of demoMethods) {
    const existing = methods.list.find((x) => x.demo && x.name === dm.name);
    if (existing) { ids[dm.key] = existing.id; continue; }
    const m = { id: newMethodId(), name: dm.name, type: dm.type, color: nextColor(methods.list), demo: true };
    if (dm.brand) m.brand = dm.brand;
    if (dm.last4) m.last4 = dm.last4;
    methods.list.push(m);
    ids[dm.key] = m.id;
  }
  const base = { createdAt: new Date().toISOString(), source: 'manual', demo: true, memo: '' };
  const demo = [
    { store: 'スーパーみどり 中央店', category: '食費', pay: 'cash', date: d(0), items: [{ name: '牛乳 1000ml', price: 238 }, { name: '食パン 6枚切', price: 158 }, { name: 'たまご 10個入', price: 258 }, { name: 'バナナ', price: 198 }, { name: '鶏むね肉', price: 412 }, { name: '値引', price: -50 }, { name: 'キッチンペーパー', price: 298 }], total: 1512 },
    { store: 'ファミリーストア 駅前店', category: '食費', pay: 'ic', date: d(1), items: [{ name: 'おにぎり 鮭', price: 160 }, { name: '緑茶 500ml', price: 151 }], total: 311 },
    { store: '定食 さくら', category: '外食', pay: 'qr', date: d(1), items: [{ name: '日替わり定食', price: 980 }], total: 980 },
    { store: 'くすりのハナ 本町店', category: '日用品', pay: 'cardA', date: d(3), items: [{ name: '洗濯洗剤', price: 598 }, { name: 'ティッシュ5箱', price: 398 }], total: 1095 },
    { store: '市営バス', category: '交通', pay: 'ic', date: d(4), items: [], total: 230 },
    { store: 'ブックス本町', category: '趣味・衣服', pay: 'cardB', date: d(5), items: [{ name: '文庫本', price: 880 }], total: 880 },
    { store: 'スーパーみどり 中央店', category: '食費', pay: 'cardA', date: d(6), items: [{ name: '米 5kg', price: 2380 }], total: 2380 },
  ];
  demo.forEach(({ pay, ...r }) => {
    const m = methods.get(ids[pay]);
    store.list.push({ ...base, ...r, id: uid(), paymentId: m.id, payment: m.name });
  });
  methods.save();
  store.save();
  render();
  toast('お試しデータを入れました。設定からまとめて消せます');
}

function clearDemo() {
  const n = store.list.filter((r) => r.demo).length;
  store.list = store.list.filter((r) => !r.demo);
  const before = methods.list.length;
  methods.list = methods.list.filter((m) => !m.demo || store.list.some((r) => r.paymentId === m.id));
  if (!methods.list.length) methods.list = defaultMethods();
  if (methods.list.length !== before) methods.save();
  store.save();
  if (filter && filter.kind === 'method' && !methods.get(filter.value)) filter = null;
  render();
  toast(n ? `お試しデータ ${n}件を消しました` : 'お試しデータはありません');
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
  $('tab-cat').addEventListener('click', () => { prefs.set('view', 'cat'); if (filter && filter.kind !== 'cat') filter = null; render(); });
  $('tab-pay').addEventListener('click', () => { prefs.set('view', 'pay'); if (filter && filter.kind === 'cat') filter = null; render(); });
  $('filter-clear').addEventListener('click', () => { filter = null; render(); });
  $('start-scan').addEventListener('click', openScan);
  $('manual-add').addEventListener('click', () => openEditor(null));
  $('add-demo').addEventListener('click', addDemo);
  $('close-scan').addEventListener('click', closeScan);
  $('scan-error-close').addEventListener('click', closeScan);
  $('scan-reset').addEventListener('click', () => { shownIds = new Set(); matchedOnce = false; autoStop = true; resetDoneState(); scanner?.reset(); });
  $('scan-resume').addEventListener('click', () => {
    // 一致した内容に納得できないときは、読み取りを続ける(やり直すまでは自動で止めない)
    autoStop = false;
    resetDoneState();
    $('scan').classList.add('is-scanning');
    renderTape(lastSnap);
  });
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
  $('f-pay').addEventListener('change', () => { $('f-pay-field').classList.remove('need'); syncLearn(); });
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

  $('open-methods').addEventListener('click', openMethods);
  $('add-method').addEventListener('click', () => openMethodEditor(null));
  $('method-form').addEventListener('submit', saveMethod);
  $('m-delete').addEventListener('click', () => { $('m-confirm-del').hidden = false; });
  $('m-del-cancel').addEventListener('click', () => { $('m-confirm-del').hidden = true; });
  $('m-del-ok').addEventListener('click', deleteMethod);

  $('open-settings').addEventListener('click', () => { $('clear-confirm').hidden = true; renderMethodList(); $('settings').showModal(); });
  $('export-csv').addEventListener('click', exportCSV);
  $('export-json').addEventListener('click', exportJSON);
  $('import-json').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importJSON(f); e.target.value = ''; });
  $('clear-demo').addEventListener('click', clearDemo);
  $('clear-all').addEventListener('click', () => { $('clear-confirm').hidden = false; });
  $('clear-cancel').addEventListener('click', () => { $('clear-confirm').hidden = true; });
  $('clear-ok').addEventListener('click', () => {
    store.list = []; store.save(); filter = null; render();
    $('clear-confirm').hidden = true; $('settings').close(); toast('すべての記録を消しました(支払方法の登録は残っています)');
  });
}

// ---- タブの重複を防ぐ ------------------------------------------------------
// ブラウザによっては、ホーム画面のショートカットから開くたびに新しいタブが増える。
// このアプリを表示したタブが「いま表示中」と知らせ、裏に残っている古いタブは自分を閉じる。
// (ショートカットから開いたタブは履歴が1件だけなので、ブラウザがスクリプトからの close を許す)
const TAB_ID = uid();
function hasUnsavedWork() {
  return !$('scan').hidden || $('editor').open || $('method-editor').open;
}
function setupSingleTab() {
  if (!('BroadcastChannel' in window)) return;
  const ch = new BroadcastChannel('receipt-kakeibo-tabs');
  const announce = () => { if (document.visibilityState === 'visible') ch.postMessage({ type: 'shown', id: TAB_ID }); };
  ch.onmessage = (e) => {
    if (!e.data || e.data.type !== 'shown' || e.data.id === TAB_ID) return;
    // 自分が表示中、または入力途中なら閉じない
    if (document.visibilityState === 'visible' || hasUnsavedWork()) return;
    window.close();
  };
  document.addEventListener('visibilitychange', announce);
  window.addEventListener('pageshow', announce);
  document.addEventListener('resume', announce);
  announce();
}

// 別のタブで保存した内容を、このタブの表示にも反映する
window.addEventListener('storage', (e) => {
  if (![STORAGE_KEY, METHODS_KEY, PREF_KEY].includes(e.key)) return;
  store.load();
  methods.load();
  prefs.load();
  if (filter && filter.kind === 'method' && !methods.get(filter.value)) filter = null;
  render();
  if ($('methods').open) renderMethodList();
});

// ---- 起動 -------------------------------------------------------------
store.load();
methods.load();
prefs.load();
// 以前の版の記録(支払い名だけを持つ)を、登録済みの支払方法に結び付ける
if (migrateRecords(store.list, methods.list, newMethodId)) store.save();
methods.save();
buildCategoryChips();
buildMethodEditorStatic();
bind();
render();
setupSingleTab();
try { navigator.storage?.persist?.(); } catch { /* 非対応 */ }
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 一度でも読み取りを使った端末では、すぐ始められるよう OCR エンジンを裏で準備しておく
let usedBefore = false;
try { usedBefore = localStorage.getItem('receipt-kakeibo:ocr-used') === '1'; } catch { /* 無視 */ }
if (usedBefore && window.isSecureContext) setTimeout(() => { prepareOCR().catch(() => {}); }, 1500);
