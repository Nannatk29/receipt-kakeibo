// npm test で実行
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLine, parseFrame, findDate, ReceiptAccumulator, reconcile, guessCategory } from '../js/parser.js';

const L = (text, confidence = 90) => ({ text, confidence });
const today = new Date('2026-11-27T12:00:00');

test('全角数字・円記号・漢字間の空白を整える', () => {
  assert.equal(normalizeLine('牛 乳　１０００ml   ￥２３８'), '牛乳 1000ml ¥238');
  assert.equal(normalizeLine('合 言十  \\1,512'), '合計 ¥1,512');
});

test('日付の書式', () => {
  assert.equal(findDate('2026年11月25日(水) 18:42', today), '2026-11-25');
  assert.equal(findDate('2026/11/26 08:12', today), '2026-11-26');
  assert.equal(findDate('令和8年11月3日', today), '2026-11-03');
  assert.equal(findDate('26/11/20 14:03', today), '2026-11-20');
  assert.equal(findDate('2027年1月1日', today), null); // 未来日は採用しない
});

test('1フレームの解析: 品目・数量行・値引・合計・支払い', () => {
  const r = parseFrame([
    L('スーパーみどり 中央店'), L('TEL 03-1234-5678'), L('2026年11月25日(水) 18:42'),
    L('牛乳 1000ml          ¥238※'), L('食パン 6枚切   革158軽'), L('バナナ'), L('  2コX単99        ¥198※'),
    L('  値引            -50'), L('人計           ¥544'), L('(8%対象  ¥1,214)'),
    L('合 計          \\544'), L('お預り   ¥1,000'), L('お釣り   ¥456'),
  ], today);
  assert.deepEqual(r.items.map((i) => [i.name, i.price]), [['牛乳 1000ml', 238], ['食パン 6枚切', 158], ['バナナ', 198], ['値引', -50]]);
  assert.equal(r.total.value, 544);
  assert.equal(r.subtotal, 544);
  assert.equal(r.date.value, '2026-11-25');
  assert.deepEqual(r.store.map((s) => s.name), ['スーパーみどり中央店']);
  assert.equal(r.payment, '現金');
});

test('外税のレシートは 品目計+外税=合計 で一致とみなす', () => {
  const acc = new ReceiptAccumulator();
  const frame = [L('洗濯洗剤        598'), L('ティッシュ5箱     398'), L('小計        996'), L('外税 10%      99'), L('合計     ¥1,095')];
  acc.addFrame(parseFrame(frame, today));
  acc.addFrame(parseFrame(frame, today));
  const s = acc.snapshot();
  assert.equal(s.sum, 996);
  assert.equal(s.taxOut, 99);
  assert.equal(s.match, true);
});

test('複数フレーム: 2回以上見えた行だけ確定し、同じ行の読み違いはまとめる', () => {
  const acc = new ReceiptAccumulator();
  acc.addFrame(parseFrame([L('おにぎり 鮭      ¥160'), L('緑茶 500ml      ¥151'), L('ノイズ行      ¥777', 40)], today));
  acc.addFrame(parseFrame([L('おにぎり 鮭      ¥160'), L('緑荼 5O0ml      ¥151'), L('合計   ¥311')], today));
  const s = acc.snapshot();
  const confirmed = s.items.filter((i) => i.confirmed);
  assert.deepEqual(confirmed.map((i) => i.price), [160, 151]);
  assert.equal(s.match, true);
  assert.ok(s.items.some((i) => !i.confirmed && i.price === 777));
});

test('同時に写らない同額の隣接行は同じ行として統合する', () => {
  const acc = new ReceiptAccumulator();
  acc.addFrame(parseFrame([L('キャベツ    ¥178'), L('緑茶 2L    ¥168'), L('食器用洗剤   ¥328')], today));
  acc.addFrame(parseFrame([L('キャベツ    ¥178'), L('るヨーとの|   ¥168'), L('食器用洗剤   ¥328')], today));
  acc.addFrame(parseFrame([L('キャベツ    ¥178'), L('緑茶 2L    ¥168'), L('食器用洗剤   ¥328')], today));
  const s = acc.snapshot();
  assert.deepEqual(s.items.map((i) => i.price), [178, 168, 328]);
  assert.equal(s.items[1].name, '緑茶 2L');
});

test('合計に合わない1文字の読み違いを、解が1つのときだけ直す', () => {
  const list = [
    { id: 1, name: '鶏むね肉', price: 412, confirmed: true, hits: 4, variants: [412] },
    { id: 2, name: '値引', price: -59, confirmed: true, hits: 3, variants: [-59] },
  ];
  const r = reconcile(list, 362, null);
  assert.equal(r.kind, 'digit');
  assert.equal(list[1].price, -50);
  assert.equal(list[1].adjusted, true);
});

test('店名からカテゴリを推定', () => {
  assert.equal(guessCategory('くすりのハナ 本町店'), null);
  assert.equal(guessCategory('ドラッグストア ハナ'), '日用品');
  assert.equal(guessCategory('スーパーみどり'), '食費');
});

// ---- 支払方法 ---------------------------------------------------------
import { detectPayment } from '../js/parser.js';
import { matchMethod, migrateRecords, summarizeByMethod, defaultMethods } from '../js/payments.js';

test('レシートの行から支払方法の手がかりを読む', () => {
  assert.deepEqual(detectPayment('クレジット VISA'), { brand: 'VISA', type: 'credit' });
  assert.deepEqual(detectPayment('カード番号 ****-****-****-1234'), { last4: '1234' });
  assert.deepEqual(detectPayment('PayPay支払  ¥842'), { service: 'PayPay', type: 'qr' });
  assert.deepEqual(detectPayment('モバイルSuica ¥230'), { service: 'Suica', type: 'emoney' });
  assert.deepEqual(detectPayment('デビット VISA'), { brand: 'VISA', type: 'debit' });
  assert.deepEqual(detectPayment('カード番号 ネネネネネネネネネネネネ*1234'), { last4: '1234' }); // 伏せ字の誤読
  assert.deepEqual(detectPayment('カード番号 ??-??-5678'), { last4: '5678' });
  // 誤検出しないもの
  assert.deepEqual(detectPayment('Liquid soap  ¥398'), {});
  assert.deepEqual(detectPayment('ポイントカード提示'), {});
  assert.deepEqual(detectPayment('会員番号 ********9999'), {});
});

test('複数フレームでは現金より具体的な支払方法を優先する', () => {
  const acc = new ReceiptAccumulator();
  acc.addFrame(parseFrame([L('おにぎり   ¥160'), L('合計   ¥160'), L('お預り ¥0')], today));
  acc.addFrame(parseFrame([L('合計   ¥160'), L('クレジット   ¥160'), L('VISA'), L('XXXXXXXXXXXX1234')], today));
  assert.deepEqual(acc.snapshot().paymentHint, { type: 'credit', brand: 'VISA', last4: '1234' });
});

const M = [
  { id: 'cash', name: '現金', type: 'cash' },
  { id: 'raku', name: '楽天カード', type: 'credit', brand: 'VISA', last4: '1234' },
  { id: 'aeon', name: 'イオンカード', type: 'credit', brand: 'Mastercard' },
  { id: 'old', name: '昔のカード', type: 'credit', brand: 'JCB', archived: true },
  { id: 'pay', name: 'PayPay', type: 'qr' },
  { id: 'sui', name: 'モバイルSuica', type: 'emoney' },
];

test('下4桁・サービス名・ブランドで登録済みの支払方法を選ぶ', () => {
  assert.equal(matchMethod({ type: 'credit', last4: '1234' }, M).id, 'raku');
  assert.equal(matchMethod({ type: 'qr', service: 'PayPay' }, M).id, 'pay');
  assert.equal(matchMethod({ type: 'emoney', service: 'Suica' }, M).id, 'sui');
  assert.equal(matchMethod({ type: 'credit', brand: 'Mastercard' }, M).id, 'aeon');
  assert.equal(matchMethod({ type: 'cash' }, M).id, 'cash');
});

test('決めきれないときは候補を返し、未登録なら missing を返す', () => {
  const r = matchMethod({ type: 'credit' }, M);
  assert.equal(r.id, undefined);
  assert.deepEqual(r.candidates, ['raku', 'aeon']); // 非表示のカードは候補に入れない
  assert.equal(matchMethod({ type: 'credit', brand: 'JCB' }, M).candidates.length, 2);
  assert.equal(matchMethod({ type: 'debit' }, M).missing, true);
  assert.equal(matchMethod({}, M), null);
  // 下4桁だけ(種類が分からない)ではカード払いと決めつけない
  assert.equal(matchMethod({ last4: '9999' }, M), null);
});

test('以前の版の記録を支払方法に結び付ける', () => {
  const methods = defaultMethods();
  const records = [{ payment: '現金' }, { payment: 'クレジット' }, { payment: 'クレジット' }, { payment: 'QR決済' }, {}];
  let n = 0;
  assert.equal(migrateRecords(records, methods, () => `m${++n}`), true);
  assert.deepEqual(methods.map((m) => [m.name, m.type]), [['現金', 'cash'], ['クレジットカード', 'credit'], ['QR決済', 'qr']]);
  assert.deepEqual(records.map((r) => r.paymentId), ['pm_cash', 'm1', 'm1', 'm2', 'pm_cash']);
  assert.equal(migrateRecords(records, methods, () => 'x'), false);
});

test('支払方法別の集計は種類ごとにまとめる', () => {
  const recs = [
    { paymentId: 'raku', total: 3000 }, { paymentId: 'aeon', total: 1000 }, { paymentId: 'raku', total: 500 },
    { paymentId: 'cash', total: 1200 }, { paymentId: 'pay', total: 800 },
  ];
  const g = summarizeByMethod(recs, M);
  assert.deepEqual(g.map((x) => [x.type, x.total, x.count]), [['credit', 4500, 3], ['cash', 1200, 1], ['qr', 800, 1]]);
  assert.deepEqual(g[0].methods.map((x) => [x.method.id, x.total]), [['raku', 3500], ['aeon', 1000]]);
});
