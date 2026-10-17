// Audio signal analysis (Music Information Retrieval) in pure JavaScript.
//
// Given a mono PCM waveform (Float32Array) and its sample rate, computes
// spectral, tonal, rhythmic and dynamic descriptors without native addons:
//
//   bpm               estimated tempo in [60, 180] BPM from onset autocorrelation
//   pulseClarity      beat regularity / strength in [0, 1]
//   key               pitch class ('C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')
//   mode              'major' | 'minor' (Krumhansl-Kessler key-profile match)
//   tonalClarity      key correlation strength in [0, 1]
//   chroma            12-element pitch-class profile (C..B), sum-normalized to 1
//   spectralCentroid  center of gravity of the spectrum in Hz
//   brightness        normalized spectral centroid in [0, 1]
//   spectralRolloff   85% cumulative energy cutoff frequency in Hz
//   spectralFlatness  Wiener entropy in [0, 1] (0 = pure tone, 1 = white noise)
//   spectralFlux      frame-to-frame spectral change in [0, 1]
//   bandEnergy        { low, mid, high } energy fractions (20-250, 250-4k, 4k+ Hz)
//   rmsDb             root-mean-square loudness in dBFS
//   dynamicRange      dB spread between 95th and 10th percentile active frame levels
//   zeroCrossingRate  fraction of sign changes per sample

import { keyDistance } from '../layout.js';

export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Krumhansl-Kessler cognitive key profiles (C major and C minor).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** In-place radix-2 Cooley-Tukey FFT. `re` and `im` must have power-of-two length N. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function pearsonCorrelation(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 1e-12 ? num / den : 0;
}

/** Estimate key and mode from a 12-bin chroma vector. */
export function estimateKeyFromChroma(chroma) {
  let bestKey = 'C';
  let bestMode = 'major';
  let bestCorr = -Infinity;

  for (let root = 0; root < 12; root += 1) {
    const rotatedMajor = new Array(12);
    const rotatedMinor = new Array(12);
    for (let i = 0; i < 12; i += 1) {
      rotatedMajor[i] = MAJOR_PROFILE[(i - root + 12) % 12];
      rotatedMinor[i] = MINOR_PROFILE[(i - root + 12) % 12];
    }
    const corrMajor = pearsonCorrelation(chroma, rotatedMajor);
    if (corrMajor > bestCorr) {
      bestCorr = corrMajor;
      bestKey = PITCH_CLASSES[root];
      bestMode = 'major';
    }
    const corrMinor = pearsonCorrelation(chroma, rotatedMinor);
    if (corrMinor > bestCorr) {
      bestCorr = corrMinor;
      bestKey = PITCH_CLASSES[root];
      bestMode = 'minor';
    }
  }

  return {
    key: bestKey,
    mode: bestMode,
    tonalClarity: Number(Math.max(0, Math.min(1, bestCorr)).toFixed(3)),
  };
}

/**
 * Estimate BPM and pulse clarity from an onset-strength envelope sampled at
 * `frameRate` Hz (frames per second).
 */
export function estimateTempoFromOnsets(onsets, frameRate) {
  if (!onsets || onsets.length < 16 || !(frameRate > 0)) {
    return { bpm: null, pulseClarity: 0 };
  }

  // Subtract local moving average so steady drone energy does not masquerade as rhythm,
  // then apply a 3-tap Gaussian smoothing kernel so beats between frame boundaries
  // correlate cleanly.
  const n = onsets.length;
  const halfWin = Math.max(2, Math.round(frameRate * 0.25));
  const rect = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    for (let j = lo; j <= hi; j += 1) {
      sum += onsets[j];
      count += 1;
    }
    rect[i] = Math.max(0, onsets[i] - sum / count);
  }
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? rect[i - 1] : rect[i];
    const next = i + 1 < n ? rect[i + 1] : rect[i];
    centered[i] = 0.25 * prev + 0.5 * rect[i] + 0.25 * next;
  }

  let zeroLag = 0;
  for (let i = 0; i < n; i += 1) zeroLag += centered[i] * centered[i];
  if (zeroLag <= 1e-12) return { bpm: null, pulseClarity: 0 };

  // A beatless drone has tiny onset energy; scale clarity by onset strength per frame.
  const rmsOnset = Math.sqrt(zeroLag / n);
  const onsetStrength = Math.min(1, rmsOnset / 2.5);

  const maxLag = Math.min(n - 2, Math.ceil((frameRate * 60) / 55) * 2 + 2);
  const acf = new Float64Array(maxLag + 1);
  acf[0] = 1;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    const count = n - lag;
    for (let i = 0; i < count; i += 1) {
      sum += centered[i] * centered[i + lag];
    }
    const norm = (zeroLag * count) / n;
    acf[lag] = norm > 1e-12 ? sum / norm : 0;
  }

  const interpAcf = (tau) => {
    const k = Math.floor(tau);
    if (k < 1 || k + 1 > maxLag) return 0;
    const frac = tau - k;
    return acf[k] * (1 - frac) + acf[k + 1] * frac;
  };

  let bestBpm = null;
  let bestWeighted = -1;
  let bestRaw = 0;

  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const tau = (frameRate * 60) / bpm;
    if (tau >= n / 2) continue;
    const rawCorr = interpAcf(tau);
    const doublePeriod = tau * 2 <= maxLag ? Math.max(0, interpAcf(tau * 2)) : rawCorr;
    const comb = 0.7 * rawCorr + 0.3 * doublePeriod;
    // Perceptual tempo prior centered around 120 BPM in log-tempo space.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.55) ** 2);
    const weighted = comb * (0.65 + 0.35 * prior);

    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestRaw = Math.max(0, Math.min(1, rawCorr * onsetStrength));
      bestBpm = bpm;
    }
  }

  if (bestRaw < 0.08) return { bpm: null, pulseClarity: Number(bestRaw.toFixed(3)) };
  return {
    bpm: bestBpm,
    pulseClarity: Number(bestRaw.toFixed(3)),
  };
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Compute MIR descriptors from a mono PCM waveform.
 * @param {Float32Array|Float64Array|number[]} samples
 * @param {number} sampleRate
 */
export function analyzePcm(samples, sampleRate = 22050, { frameSize = 2048, hopSize = 512 } = {}) {
  if (!samples || samples.length < frameSize || !(sampleRate > 0)) return null;

  const totalSamples = samples.length;
  let sqSum = 0;
  let zeroCrossings = 0;
  for (let i = 0; i < totalSamples; i += 1) {
    const s = samples[i];
    sqSum += s * s;
    if (i > 0 && ((samples[i - 1] >= 0 && s < 0) || (samples[i - 1] < 0 && s >= 0))) {
      zeroCrossings += 1;
    }
  }
  const rms = Math.sqrt(sqSum / totalSamples);
  if (rms < 1e-6) return null; // silence
  const rmsDb = 20 * Math.log10(Math.max(1e-6, rms));
  const zeroCrossingRate = zeroCrossings / (totalSamples - 1);

  const halfBins = frameSize >> 1;
  const binHz = sampleRate / frameSize;
  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
  }

  // Precompute bin -> pitch class for [65 Hz, 2093 Hz] (C2..C7).
  const binPitchClass = new Int8Array(halfBins).fill(-1);
  for (let k = 1; k < halfBins; k += 1) {
    const freq = k * binHz;
    if (freq >= 65 && freq <= 2093) {
      const midi = Math.round(69 + 12 * Math.log2(freq / 440));
      binPitchClass[k] = ((midi % 12) + 12) % 12;
    }
  }

  const numFrames = Math.floor((totalSamples - frameSize) / hopSize) + 1;
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const prevMag = new Float64Array(halfBins);
  const chromaAccum = new Float64Array(12);
  const onsets = new Float64Array(numFrames);
  const frameDb = [];

  let centroidSum = 0;
  let rolloffSum = 0;
  let flatnessSum = 0;
  let fluxSum = 0;
  let activeFrames = 0;
  let lowEnergy = 0;
  let midEnergy = 0;
  let highEnergy = 0;

  for (let f = 0; f < numFrames; f += 1) {
    const offset = f * hopSize;
    let frameSq = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const s = samples[offset + i];
      frameSq += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    const frameRms = Math.sqrt(frameSq / frameSize);
    if (frameRms > 1e-5) frameDb.push(20 * Math.log10(frameRms));

    fft(re, im);

    let magSum = 0;
    let powerSum = 0;
    let weightedFreqSum = 0;
    let logPowerSum = 0;
    let positiveFlux = 0;
    let l2Flux = 0;

    const power = new Float64Array(halfBins);
    for (let k = 1; k < halfBins; k += 1) {
      const mag = Math.hypot(re[k], im[k]);
      const p = mag * mag;
      power[k] = p;
      magSum += mag;
      powerSum += p;
      const freq = k * binHz;
      weightedFreqSum += freq * mag;
      logPowerSum += Math.log(Math.max(1e-12, p));

      // Log-compressed spectral flux for onset detection.
      const logMag = Math.log1p(10 * mag);
      const diff = logMag - prevMag[k];
      if (diff > 0) positiveFlux += diff;
      l2Flux += diff * diff;
      prevMag[k] = logMag;

      if (freq >= 20 && freq < 250) lowEnergy += p;
      else if (freq >= 250 && freq < 4000) midEnergy += p;
      else if (freq >= 4000) highEnergy += p;

      const pc = binPitchClass[k];
      if (pc >= 0) chromaAccum[pc] += mag;
    }

    onsets[f] = f === 0 ? 0 : positiveFlux;

    if (magSum > 1e-6 && powerSum > 1e-9) {
      activeFrames += 1;
      centroidSum += weightedFreqSum / magSum;

      // 85% cumulative power rolloff.
      const target = 0.85 * powerSum;
      let acc = 0;
      let rolloffHz = (halfBins - 1) * binHz;
      for (let k = 1; k < halfBins; k += 1) {
        acc += power[k];
        if (acc >= target) {
          rolloffHz = k * binHz;
          break;
        }
      }
      rolloffSum += rolloffHz;

      // Spectral flatness: geometric mean / arithmetic mean of power spectrum.
      const nBins = halfBins - 1;
      const geomMean = Math.exp(logPowerSum / nBins);
      const arithMean = powerSum / nBins;
      flatnessSum += Math.min(1, geomMean / Math.max(1e-12, arithMean));

      if (f > 0) {
        fluxSum += Math.min(1, Math.sqrt(l2Flux / nBins));
      }
    }
  }

  const chromaSum = chromaAccum.reduce((a, b) => a + b, 0);
  const chroma = Array.from(chromaAccum, (v) => round(chromaSum > 0 ? v / chromaSum : 1 / 12, 4));
  const { key, mode, tonalClarity } = estimateKeyFromChroma(chroma);

  const frameRate = sampleRate / hopSize;
  const { bpm, pulseClarity } = estimateTempoFromOnsets(onsets, frameRate);

  const meanCentroid = activeFrames > 0 ? centroidSum / activeFrames : 0;
  const meanRolloff = activeFrames > 0 ? rolloffSum / activeFrames : 0;
  const meanFlatness = activeFrames > 0 ? flatnessSum / activeFrames : 0;
  const meanFlux = activeFrames > 1 ? fluxSum / (activeFrames - 1) : 0;
  const brightness = Math.max(0, Math.min(1, (meanCentroid - 200) / 5000));

  const totalBand = lowEnergy + midEnergy + highEnergy || 1;
  const bandEnergy = {
    low: round(lowEnergy / totalBand, 3),
    mid: round(midEnergy / totalBand, 3),
    high: round(highEnergy / totalBand, 3),
  };

  frameDb.sort((a, b) => a - b);
  const p95 = frameDb.length ? frameDb[Math.floor((frameDb.length - 1) * 0.95)] : rmsDb;
  const p10 = frameDb.length ? frameDb[Math.floor((frameDb.length - 1) * 0.10)] : rmsDb;
  const dynamicRange = Math.max(0, p95 - p10);

  return {
    bpm,
    pulseClarity,
    key,
    mode,
    tonalClarity,
    chroma,
    spectralCentroid: Math.round(meanCentroid),
    brightness: round(brightness, 3),
    spectralRolloff: Math.round(meanRolloff),
    spectralFlatness: round(meanFlatness, 3),
    spectralFlux: round(meanFlux, 3),
    bandEnergy,
    rmsDb: round(rmsDb, 2),
    dynamicRange: round(dynamicRange, 2),
    zeroCrossingRate: round(zeroCrossingRate, 4),
  };
}

/**
 * Decode a standard RIFF WAVE buffer (8/16/24/32-bit PCM or 32-bit float) into
 * a mono Float32Array and sampleRate.
 */
export function parseWavPcm(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44) throw new Error('WAV buffer too short');
  const fourcc = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE') throw new Error('Not a RIFF WAVE file');

  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 22050;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourcc(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size & 1);
  }
  if (dataOffset < 0 || channels < 1) throw new Error('WAV missing data chunk');

  const bytesPerSample = bitsPerSample >> 3;
  const blockAlign = channels * bytesPerSample;
  const frames = Math.floor(dataSize / blockAlign);
  const samples = new Float32Array(frames);

  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const pos = dataOffset + i * blockAlign + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = view.getFloat32(pos, true);
      } else if (bitsPerSample === 8) {
        val = (bytes[pos] - 128) / 128;
      } else if (bitsPerSample === 16) {
        val = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
        val = ((b0 & 0x800000 ? b0 | ~0xffffff : b0)) / 8388608;
      } else if (bitsPerSample === 32) {
        val = view.getInt32(pos, true) / 2147483648;
      }
      sum += val;
    }
    samples[i] = sum / channels;
  }

  return { samples, sampleRate };
}

/**
 * Octave-aware tempo similarity in [0, 1].
 * Tracks at 70 BPM and 140 BPM share a half/double-time relationship.
 */
export function tempoSimilarity(bpmA, bpmB) {
  if (!(bpmA > 0) || !(bpmB > 0)) return null;
  const direct = Math.max(0, 1 - Math.abs(bpmA - bpmB) / 60);
  const doubleA = Math.max(0, 1 - Math.abs(bpmA * 2 - bpmB) / 60) * 0.85;
  const doubleB = Math.max(0, 1 - Math.abs(bpmA - bpmB * 2) / 60) * 0.85;
  return Math.max(direct, doubleA, doubleB);
}

/**
 * Compare two audio feature profiles in [0, 1] across whichever descriptors
 * both tracks possess (tempo, key/chroma, brightness, band energy, pulse, flatness, dynamics).
 */
export function audioSimilarity(a = {}, b = {}) {
  const parts = [];

  const bpmScore = tempoSimilarity(a.bpm, b.bpm);
  if (bpmScore != null) parts.push([1.0, bpmScore]);

  if (Array.isArray(a.chroma) && Array.isArray(b.chroma) && a.chroma.length === 12 && b.chroma.length === 12) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < 12; i += 1) {
      dot += a.chroma[i] * b.chroma[i];
      normA += a.chroma[i] * a.chroma[i];
      normB += b.chroma[i] * b.chroma[i];
    }
    const cos = normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
    parts.push([1.0, Math.max(0, Math.min(1, cos))]);
  } else if (a.key && b.key) {
    let score = 1 - keyDistance(a.key, b.key);
    if (a.mode && b.mode && a.mode !== b.mode) score *= 0.85;
    parts.push([0.8, score]);
  }

  if (a.brightness != null && b.brightness != null) {
    parts.push([0.7, Math.max(0, 1 - Math.abs(a.brightness - b.brightness))]);
  }

  if (a.pulseClarity != null && b.pulseClarity != null) {
    parts.push([0.6, Math.max(0, 1 - Math.abs(a.pulseClarity - b.pulseClarity))]);
  }

  if (a.bandEnergy && b.bandEnergy && a.bandEnergy.low != null && b.bandEnergy.low != null) {
    const l1 = Math.abs(a.bandEnergy.low - b.bandEnergy.low)
      + Math.abs((a.bandEnergy.mid ?? 0) - (b.bandEnergy.mid ?? 0))
      + Math.abs((a.bandEnergy.high ?? 0) - (b.bandEnergy.high ?? 0));
    parts.push([0.7, Math.max(0, 1 - l1 / 2)]);
  }

  if (a.spectralFlatness != null && b.spectralFlatness != null) {
    parts.push([0.4, Math.max(0, 1 - Math.abs(a.spectralFlatness - b.spectralFlatness))]);
  }

  if (a.dynamicRange != null && b.dynamicRange != null) {
    parts.push([0.4, Math.max(0, 1 - Math.abs(a.dynamicRange - b.dynamicRange) / 20)]);
  }

  if (parts.length === 0) return null;
  let weightSum = 0;
  let total = 0;
  for (const [w, s] of parts) {
    weightSum += w;
    total += w * s;
  }
  return total / weightSum;
}
