import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// demo/guano.js is a browser script; its drawing waits for a canvas, the rest runs anywhere.
const context = { window: {} };
runInNewContext(readFileSync(new URL('../demo/guano.js', import.meta.url), 'utf8'), context);
const Guano = context.window.Guano;

test('every sprite is a full rectangle drawn only with palette colours', () => {
  for (const [name, rows] of Object.entries(Guano.SPRITES)) {
    assert.ok(rows.length > 0, name);
    for (const row of rows) {
      assert.equal(row.length, rows[0].length, `${name} rows differ in width`);
      for (const ch of row) assert.ok(ch === '.' || ch in Guano.PALETTE, `${name} uses an unknown pixel "${ch}"`);
    }
  }
  const map = ['idle0', 'idle1', 'walk0', 'walk1', 'walk2', 'walk3', 'listen0', 'listen1', 'dance0', 'dance1', 'dance2', 'dance3', 'rest0'];
  for (const name of map) assert.deepEqual([Guano.SPRITES[name].length, Guano.SPRITES[name][0].length], [24, 24], name);
  assert.deepEqual([Guano.SPRITES.face.length, Guano.SPRITES.face[0].length], [32, 32]);
});

test('he dances to upbeat songs and vibes to calm ones', () => {
  const mood = (genres, extra = {}) => Guano.grooves({ genres, ...extra });
  assert.equal(mood(['deep house']), 'dance');
  assert.equal(mood(['rock', 'funk / soul', 'doo wop', 'rhythm & blues']), 'dance');
  assert.equal(mood(['ambient']), 'vibe');
  assert.equal(mood(['classical', 'romantic', 'piano']), 'vibe');
  assert.equal(mood(['funk / soul', 'jazz', 'soul-jazz']), 'vibe', 'mostly jazz');
  assert.equal(mood(['electronic']), 'vibe', '"electronic" alone says nothing about the tempo');
  assert.equal(mood([]), 'vibe');
  assert.equal(mood([], { showGenres: ['Drum & Bass', 'Jungle'] }), 'dance', 'the show decides when the song has no genres');
  assert.equal(mood(['ambient'], { bpm: 128 }), 'dance', 'a known tempo wins');
  assert.equal(mood(['deep house'], { bpm: 72 }), 'vibe');
});

test('each mood cycles through its own frames, on the beat when the tempo is known', () => {
  const frames = (mood, step, n, options) => Array.from({ length: n }, (_, i) => Guano.frame(mood, i * step, options));
  assert.deepEqual(frames('walk', 110, 5), ['walk0', 'walk1', 'walk2', 'walk3', 'walk0']);
  assert.deepEqual(frames('dance', 250, 4), ['dance0', 'dance1', 'dance2', 'dance3'], '120 BPM by default');
  assert.deepEqual(frames('dance', 500, 4, { bpm: 60 }), ['dance0', 'dance1', 'dance2', 'dance3']);
  assert.deepEqual(frames('vibe', 750, 3), ['listen0', 'listen1', 'listen0']);
  assert.equal(Guano.frame('rest', 1234), 'rest0');
  assert.equal(Guano.frame('idle', 0), 'idle0');
  assert.equal(Guano.frame('idle', 3300), 'idle1', 'he blinks now and then');
  assert.equal(Guano.frame('dance', 999, { still: true }), 'dance0', 'reduced motion holds one frame');
});

test('notes rise while he listens and z\'s while he rests; nothing otherwise', () => {
  const rising = [200, 600, 1000, 1400, 1800].map((ms) => Guano.particles('dance', ms).find((p) => p.id === 0));
  const heights = rising.filter(Boolean).map((p) => p.y);
  assert.ok(heights.length >= 2 && heights.every((y, i) => !i || y <= heights[i - 1]), 'notes float upwards');
  assert.ok(Guano.particles('rest', 700).every((p) => p.name === 'zz'));
  assert.equal(Guano.particles('walk', 700).length, 0);
  assert.equal(Guano.particles('idle', 700).length, 0);
  assert.equal(Guano.particles('vibe', 0, { still: true }).length, 2);
});

test('redraws are scheduled only as often as his picture changes', () => {
  assert.equal(Guano.wait('walk', 0), 16);
  assert.equal(Guano.wait('dance', 0, { bpm: 240 }), 125);
  assert.ok(Guano.wait('idle', 0) > 3000, 'standing still, the next change is his blink');
  assert.ok(Guano.wait('idle', 3300) <= 101);
});
