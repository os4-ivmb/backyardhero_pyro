import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RF433_FRAME_MS_MAX,
  findBilusocnLateCues,
  rf433MinSpacingMs,
} from '../src/util/rf433.js';

const Z = new Set(['1', '2']);
const cue = (id, startTime, zone = '1', delay = 0) => ({ id, startTime, zone, delay });

test('spacing is repeats x worst-case frame, clamped to 1-10', () => {
  assert.ok(Math.abs(RF433_FRAME_MS_MAX - 47.216) < 1e-9);
  assert.equal(rf433MinSpacingMs(8), 378);
  assert.equal(rf433MinSpacingMs(3), 142);
  assert.equal(rf433MinSpacingMs(0), 378); // bad input -> default 8
  assert.equal(rf433MinSpacingMs(99), 473); // clamped to 10
});

test('well-spaced cues produce no warning', () => {
  const items = [cue('a', 1.0), cue('b', 1.4), cue('c', 1.8)];
  assert.deepEqual(findBilusocnLateCues(items, Z, 8), []);
});

test('simultaneous cues across zones queue up on the one transmitter', () => {
  const items = [cue('a', 5), cue('b', 5, '2'), cue('c', 5), cue('d', 20)];
  const [w, ...rest] = findBilusocnLateCues(items, Z, 8);
  assert.equal(rest.length, 0);
  assert.deepEqual(w.itemIds, ['a', 'b', 'c']);
  assert.equal(w.maxLateMs, 756); // third cue waits for two 378ms sends
  assert.equal(w.fromSec, 5);
});

test('lowering repeats clears the warning', () => {
  const items = [cue('a', 1.0), cue('b', 1.2)];
  assert.equal(findBilusocnLateCues(items, Z, 8).length, 1);
  assert.equal(findBilusocnLateCues(items, Z, 4).length, 0); // 189ms spacing
});

test('small delays under the threshold are ignored', () => {
  const items = [cue('a', 1.0), cue('b', 1.35)]; // 28ms late at 8 repeats
  assert.deepEqual(findBilusocnLateCues(items, Z, 8), []);
});

test('fire time subtracts item delay; native zones are ignored', () => {
  // b fires at 2.5 - 0.5 = 2.0, same as a -> late. n is a native receiver.
  const items = [cue('a', 2.0), cue('b', 2.5, '1', 0.5), cue('n', 2.0, 'RX153')];
  const [w] = findBilusocnLateCues(items, Z, 8);
  assert.deepEqual(w.itemIds, ['a', 'b']);
  assert.deepEqual(findBilusocnLateCues(items, new Set(), 8), []);
});

test('separate tight runs are reported separately', () => {
  const items = [cue('a', 1), cue('b', 1), cue('c', 10), cue('d', 10)];
  const ws = findBilusocnLateCues(items, Z, 8);
  assert.deepEqual(ws.map((w) => w.itemIds), [['a', 'b'], ['c', 'd']]);
});
