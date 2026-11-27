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
