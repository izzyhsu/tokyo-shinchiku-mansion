import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFullWidth, parseDescription } from '../lib/rss.js';

test('normalizeFullWidth converts ascii-like full width characters', () => {
  assert.equal(normalizeFullWidth('ＡＢＣ１２３'), 'ABC123');
});

test('parseDescription extracts station, line, walk, units, and price', () => {
  const parsed = parseDescription('沿線名：JR山手線 駅名：東京 - 徒歩分：徒歩 9 分 総戸数：45 戸 価格：7980万円');
  assert.deepEqual(parsed, {
    line: 'JR山手線',
    station: '東京',
    walkMin: 9,
    busMin: null,
    totalUnits: 45,
    price: '7980万円',
  });
});

test('parseDescription supports bus fallback', () => {
  const parsed = parseDescription('沿線名：東西線 駅名：葛西 バス分表示：バス 12 分 価格：5280万円');
  assert.equal(parsed.line, '東西線');
  assert.equal(parsed.station, '葛西');
  assert.equal(parsed.walkMin, null);
  assert.equal(parsed.busMin, 12);
  assert.equal(parsed.price, '5280万円');
});
