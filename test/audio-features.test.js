import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePcm,
  audioSimilarity,
  estimateKeyFromChroma,
  parseWavPcm,
  tempoSimilarity,
} from '../src/catalog/audio-features.js';
import { keyDistance } from '../src/layout.js';

const SR = 22050;

/** Synthesize a chord with harmonics and optional periodic drum clicks at `bpm`. */
function synthSignal({ freqs = [440], durationSec = 6, bpm = null, noise = 0 } = {}) {
  const n = Math.floor(SR * durationSec);
  const samples = new Float32Array(n);
  const beatSamples = bpm ? (SR * 60) / bpm : 0;

  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let val = 0;
    for (const f of freqs) {
      val += 0.6 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t);
    }
    val /= Math.max(1, freqs.length);

    if (beatSamples > 0) {
      const phase = (i % Math.round(beatSamples)) / SR;
      if (phase < 0.04) {
        const env = Math.exp(-phase * 90);
        // Kick + transient click
        val += env * (0.9 * Math.sin(2 * Math.PI * 90 * phase) + 0.5 * Math.sin(2 * Math.PI * 1800 * phase));
      }
    }
    if (noise > 0) {
      // Deterministic pseudo-noise
      const h = Math.sin(i * 12.9898) * 43758.5453;
      val += noise * ((h - Math.floor(h)) * 2 - 1);
    }
    samples[i] = Math.max(-1, Math.min(1, val * 0.5));
  }
  return samples;
}

test('analyzePcm identifies key, mode and chroma from harmonic content', () => {
  // C major triad + G5 (C4=261.63, E4=329.63, G4=392.00, C5=523.25)
  const cMajor = analyzePcm(synthSignal({ freqs: [261.63, 329.63, 392.00, 523.25], durationSec: 4 }), SR);
  assert.equal(cMajor.key, 'C');
  assert.equal(cMajor.mode, 'major');
  assert.ok(cMajor.tonalClarity > 0.5);
  assert.equal(cMajor.chroma.length, 12);
  assert.ok(Math.abs(cMajor.chroma.reduce((a, b) => a + b, 0) - 1) < 0.01);

  // A minor triad (A3=220, C4=261.63, E4=329.63, A4=440)
  const aMinor = analyzePcm(synthSignal({ freqs: [220.00, 261.63, 329.63, 440.00], durationSec: 4 }), SR);
  assert.equal(aMinor.key, 'A');
  assert.equal(aMinor.mode, 'minor');
  assert.ok(aMinor.tonalClarity > 0.5);
});

test('analyzePcm estimates tempo and pulse clarity from rhythmic transients', () => {
  const club120 = analyzePcm(synthSignal({ freqs: [110], bpm: 120, durationSec: 8 }), SR);
  assert.ok(Math.abs(club120.bpm - 120) <= 2, `expected ~120 BPM, got ${club120.bpm}`);
  assert.ok(club120.pulseClarity > 0.3, `expected clear pulse, got ${club120.pulseClarity}`);

  const downtempo96 = analyzePcm(synthSignal({ freqs: [110], bpm: 96, durationSec: 8 }), SR);
  assert.ok(Math.abs(downtempo96.bpm - 96) <= 2, `expected ~96 BPM, got ${downtempo96.bpm}`);

  // Steady beatless drone has no periodic pulse.
  const drone = analyzePcm(synthSignal({ freqs: [220, 330], bpm: null, durationSec: 6 }), SR);
  assert.ok(drone.pulseClarity < club120.pulseClarity);
});

test('analyzePcm distinguishes bass-heavy, bright and noisy timbres', () => {
  const subBass = analyzePcm(synthSignal({ freqs: [80, 120], durationSec: 3 }), SR);
  const brightLead = analyzePcm(synthSignal({ freqs: [2400, 3600], durationSec: 3 }), SR);
  const noisy = analyzePcm(synthSignal({ freqs: [], noise: 0.9, durationSec: 3 }), SR);

  assert.ok(subBass.bandEnergy.low > 0.7);
  assert.ok(brightLead.bandEnergy.high > subBass.bandEnergy.high);
  assert.ok(brightLead.spectralCentroid > subBass.spectralCentroid * 4);
  assert.ok(brightLead.brightness > subBass.brightness);
  assert.ok(noisy.spectralFlatness > subBass.spectralFlatness * 5);
});

test('parseWavPcm decodes 16-bit RIFF WAVE buffers to mono Float32Array', () => {
  const numSamples = 2048;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.sin((2 * Math.PI * 440 * i) / SR);
    view.setInt16(44 + i * 2, Math.round(s * 16384), true);
  }

  const decoded = parseWavPcm(buf);
  assert.equal(decoded.sampleRate, SR);
  assert.equal(decoded.samples.length, numSamples);
  const features = analyzePcm(decoded.samples, decoded.sampleRate);
  assert.equal(features.key, 'A');
});

test('tempoSimilarity and keyDistance handle half-time and minor keys', () => {
  assert.equal(tempoSimilarity(120, 120), 1);
  assert.ok(tempoSimilarity(70, 140) >= 0.8, 'half/double-time tempos are related');
  assert.equal(keyDistance('Am', 'Am'), 0);
  assert.ok(keyDistance('Am', 'C') <= 0.1, 'relative minor and major sit together on the circle of fifths');
  assert.ok(keyDistance('Am', 'Em') < keyDistance('Am', 'Eb'));

  const a = analyzePcm(synthSignal({ freqs: [220, 261.63, 329.63], bpm: 120, durationSec: 6 }), SR);
  const b = analyzePcm(synthSignal({ freqs: [220, 261.63, 329.63], bpm: 122, durationSec: 6 }), SR);
  const c = analyzePcm(synthSignal({ freqs: [2600, 3900], noise: 0.8, bpm: 80, durationSec: 6 }), SR);
  assert.ok(audioSimilarity(a, b) > audioSimilarity(a, c) + 0.25);
});
