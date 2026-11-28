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

// ---- 実レシート(ドラッグストア、横倍角の合計・カード払い)で見つかった問題 ----------
// 行の文字列は、実際のカメラ映像を OCR した結果をそのまま使っている
const realFrame = [
  L('2026年11月11日(水)18:49 しレケ od', 68),
  L('従業軸No008177   資格者00817', 58),
  L('※サッポロー番 みぞ 5食 。 \\516', 66),
  L('(特売価格)           I', 87),
  L('シュミテクトやさしくホワイトニ', 93),
  L('3コx単767      \\2,301', 58),
  L('キュレル 皮脂トラブルケー, 320', 60),
  L('アイテム値引 15%     -\\198', 71),
  L('i 導言寺      \\3う3.所3昌', 0), // 横倍角の「合計」は読めない
  L('(内10% 対象   \\3,423)', 60),
  L('(内10%           \\311)', 31),
  L('(内 8% 対象       \\516)', 88),
  L('(内 8%                    \\38)', 87),
  L('(税合計          \\349)', 65),
  L('3S3カガード                    \\3, 939', 57),
];

test('実レシート: 税合計を合計にせず、カード払いの金額と税率ごとの対象額を拾う', () => {
  const r = parseFrame(realFrame, today);
  assert.equal(r.total, null);
  assert.equal(r.payAmount, 3939);
  assert.deepEqual(r.taxBases, { 8: 516, 10: 3423 });
  assert.equal(r.payHint.type, 'credit');
  assert.equal(r.payHint.service, '3S3カガード');
  assert.deepEqual(r.items.map((i) => [i.name, i.price, !!i.lost]), [
    ['サッポロー番みぞ 5食', 516, false], ['シュミテクトやさしくホワイトニ', 2301, false],
    ['キュレル皮脂トラブルケー', 320, true], ['アイテム値引 15%', -198, false],
  ]);
});

test('実レシート: 合計の行が読めなくても合計を割り出し、欠けた千の位を補う', () => {
  const acc = new ReceiptAccumulator();
  acc.addFrame(parseFrame(realFrame, today));
  acc.addFrame(parseFrame(realFrame, today));
  const s = acc.snapshot();
  assert.equal(s.total, 3939);
  assert.equal(s.totalSource, 'payment');
  assert.equal(s.match, true);
  assert.equal(s.reconciled.kind, 'lead');
  assert.equal(s.items.find((i) => i.name.startsWith('キュレル')).price, 1320);
});

test('合計の行を読み直せたときは、その金額を採る', () => {
  const acc = new ReceiptAccumulator();
  const fixed = realFrame.map((l) => (l.text.startsWith('i 導言寺') ? L('|合計           \\3,939', 34) : l));
  acc.addFrame(parseFrame(fixed, today));
  acc.addFrame(parseFrame(fixed, today));
  const s = acc.snapshot();
  assert.equal(s.total, 3939);
  assert.equal(s.totalSource, 'line');
});

test('金額が合計と同じ品目は、合計や支払いの行の読み違いとして外す', () => {
  const acc = new ReceiptAccumulator();
  const f = [L('おにぎり   ¥160'), L('お茶   ¥140'), L('合計   ¥300'), L('ネオカガカー   ¥300')];
  acc.addFrame(parseFrame(f, today));
  acc.addFrame(parseFrame(f, today));
  const s = acc.snapshot();
  assert.deepEqual(s.items.filter((i) => i.confirmed).map((i) => i.price), [160, 140]);
  assert.equal(s.match, true);
});

test('現金払いは お預り − お釣り からも合計を割り出す', () => {
  const acc = new ReceiptAccumulator();
  const f = [L('パン   ¥238'), L('牛乳   ¥198'), L('ギ言寺  ??', 0), L('お預り   ¥1,000'), L('お釣り   ¥564')];
  acc.addFrame(parseFrame(f, today));
  acc.addFrame(parseFrame(f, today));
  const s = acc.snapshot();
  assert.equal(s.total, 436);
  assert.equal(s.totalSource, 'cash');
  assert.equal(s.match, true);
});

test('店名: 挨拶文は使わず、電話番号と同じ行の店名を拾う', () => {
  const r = parseFrame([
    L('本日もご来店', 80), L('まことにありがとうございます', 85),
    L('アカカベ枚方公園店 072-804-4193', 82), L('2026年11月11日(水)18:49', 80),
  ], today);
  assert.deepEqual(r.store.map((s) => s.name), ['アカカベ枚方公園店']);
});

test('「○○カード ¥金額」はカード払い。ポイントカードの行はカード払いにしない', () => {
  assert.deepEqual(detectPayment('TS3カード        ¥3,939'), { type: 'credit', service: 'TS3カード' });
  assert.deepEqual(detectPayment('イオンカード払い ¥1,200'), { type: 'credit', service: 'イオンカード' });
  assert.deepEqual(detectPayment('ポイントカード ¥0'), {});
});

test('覚えたレシートの表示(OCR の崩れを許す)で支払方法を選ぶ', () => {
  const ms = [...M, { id: 'ts3', name: 'トヨタカード', type: 'credit', keywords: ['TS3カード'] }];
  assert.equal(matchMethod({ type: 'credit', service: '3S3カガード' }, ms).id, 'ts3'); // 実際の崩れ方
  assert.equal(matchMethod({ type: 'credit', service: 'セゾンカード' }, ms).id, undefined); // 別のカードとは一致しない
  assert.equal(matchMethod({ type: 'credit', service: 'TS3カード' }, ms).id, 'ts3');
  assert.equal(matchMethod({ type: 'credit', service: 'S3カード' }, ms).id, 'ts3');
});

test('崩れた数量行(「3コメx単__ 767」)も数量行として扱い、前の行の品名を使う', () => {
  const r = parseFrame([L('シュミテクトやさしくホワイトニ'), L('3コメx単__ 767        ¥2,301'), L('キュレル 皮脂トラブルケ   ¥1,320')], today);
  assert.deepEqual(r.items.map((i) => [i.name, i.price]), [['シュミテクトやさしくホワイトニ', 2301], ['キュレル皮脂トラブルケ', 1320]]);
});

// ---- 2枚目の実レシート画面で見つかった問題 ----------------------------------
import { stripEdgeJunk, pickReread } from '../js/parser.js';
import { paperBounds } from '../js/preprocess.js';

test('紙の縁を読んだゴミ文字(行頭の「|」、金額のあとの1文字)を取り除く', () => {
  assert.equal(stripEdgeJunk('|      本日もご来店      |'), '本日もご来店');
  assert.equal(stripEdgeJunk('※サッポロー番 みそ 5食 \\516 計'), '※サッポロー番 みそ 5食 \\516');
  assert.equal(stripEdgeJunk('¥238※'), '¥238※'); // 軽減税率の印は残す
  assert.equal(stripEdgeJunk('¥160 軽'), '¥160 軽');
  assert.equal(stripEdgeJunk('シュミテクトやさしくホワイトニ  に'), 'シュミテクトやさしくホワイトニ');
  assert.equal(stripEdgeJunk('サッポロ一番 みそ 5食'), 'サッポロ一番 みそ 5食');
});

test('行頭に「|」が付いた税の行や、括弧の読めない「内10%」の行を品目にしない', () => {
  const r = parseFrame([L('| (内10%           \\311)'), L('内 8%                    \\38'), L('| (税合計          \\349)'), L('アイテム値引 15%     -\\198')], today);
  assert.deepEqual(r.items.map((i) => i.price), [-198]);
});

test('崩れた金額: 「ケー.320」は千の位が欠けた疑い、「隊1,320」は ¥ の化けとして読む', () => {
  const a = parseFrame([L('キュレル 上及脂トラブルケー.320 革')], today);
  assert.deepEqual(a.items.map((i) => [i.name, i.price, i.lost]), [['キュレル上及脂トラブルケー', 320, true]]);
  const b = parseFrame([L('キュレル 皮脂トラブルケ 隊1,320')], today);
  assert.deepEqual(b.items.map((i) => [i.name, i.price]), [['キュレル皮脂トラブルケ', 1320]]);
  const c = parseFrame([L('サッポロ一番 みそ 5食')], today);
  assert.equal(c.items.length, 0); // 「5食」を金額にしない
});

test('千の位を補う候補が複数あるときは、税率ごとの対象額で決める', () => {
  const f = [
    L('※サッポロー番 みそ 5食  \\516'), L('シュミテクトやさしくホワイトニ'), L('3コx単767      \\2,301'),
    L('キュレル 皮脂トラブルケ   320'), L('アイテム値引 15%     -\\198'),
    L('(内10% 対象   \\3,423)'), L('(内 8% 対象       \\516)'), L('TS3カード      \\3,939'),
  ];
  const acc = new ReceiptAccumulator();
  acc.addFrame(parseFrame(f, today));
  acc.addFrame(parseFrame(f, today));
  const s = acc.snapshot();
  assert.equal(s.total, 3939);
  assert.equal(s.match, true);
  assert.equal(s.items.find((i) => i.name.startsWith('キュレル')).price, 1320);
  assert.equal(s.items.find((i) => i.name.startsWith('サッポロ')).price, 516);
});

test('読み直しの結果は「合計」などを含む行だけ採用する', () => {
  assert.equal(pickReread({ text: 'キュレル 上及脂トラブルケ 1,320', confidence: 40 }, [{ text: 'キ上ル導', confidence: 60 }]), null);
  const p = pickReread({ text: 'i 導言寺      \\3う3.所3昌', confidence: 0 }, [{ text: '| 合計', confidence: 40 }, { text: '\\3.939  |', confidence: 50 }]);
  assert.ok(p && /合計/.test(p.text) && /3.939/.test(p.text));
  assert.equal(pickReread({ text: '合計 ¥1,000', confidence: 30 }, [{ text: '合計 ¥1,000', confidence: 80 }]), null); // 元から読めている
});

test('紙の左右の端を見つける(文字の多い列を紙の外と誤認しない)', () => {
  const w = 200, h = 100, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = x >= 30 && x < 170;
    // 紙の中央付近は文字で暗い画素が多い
    g[y * w + x] = !paper ? 90 : (x > 80 && x < 120 && y % 3 === 0) ? 40 : 225;
  }
  const b = paperBounds(g, w, h);
  assert.ok(b && Math.abs(b.x0 - 30) <= 4 && Math.abs(b.x1 - 169) <= 4, JSON.stringify(b));
  const full = new Uint8Array(w * h).fill(225);
  assert.equal(paperBounds(full, w, h), null); // 紙が幅いっぱい
});
