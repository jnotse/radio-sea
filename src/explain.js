// Explainability: why did the engine consider two releases similar, or why did
// it pick something? Every recommendation should be able to say why.

import { isContextTag, tagLabel } from './mapping/tags.js';

export function explainSimilarity(a, b, similarity) {
  const reasons = [];

  const tagsA = new Set(a.tags?.all ?? a.styles ?? []);
  const sharedTags = (b.tags?.all ?? b.styles ?? []).filter((t) => tagsA.has(t));
  const sharedSound = sharedTags.filter((t) => !isContextTag(t));
  if (sharedSound.length > 0) reasons.push(`shared tags: ${sharedSound.slice(0, 4).join(', ')}`);
  const sharedShow = sharedTags.find((t) => t.startsWith('show:'));
  const sharedShowGenres = sharedTags.filter((t) => t.startsWith('show-genre:'));
  if (sharedShow) reasons.push(`played on the same show: ${tagLabel(sharedShow)}`);
  else if (sharedShowGenres.length > 0) {
    reasons.push(`both shows tagged: ${sharedShowGenres.slice(0, 4).map(tagLabel).join(', ')}`);
  }

  const artistsB = new Set((b.artists ?? [b.artist]).map((x) => String(x).toLowerCase()));
  const sharedArtists = (a.artists ?? [a.artist]).filter((x) => artistsB.has(String(x).toLowerCase()));
  if (sharedArtists.length > 0) reasons.push(`same artist: ${sharedArtists.join(', ')}`);

  if (a.label && b.label && String(a.label).toLowerCase() === String(b.label).toLowerCase()) {
    reasons.push(`same label: ${a.label}`);
  }

  if (a.year != null && b.year != null) {
    const gap = Math.abs(a.year - b.year);
    reasons.push(gap === 0 ? `both from ${a.year}` : `${gap} year${gap === 1 ? '' : 's'} apart (${a.year} / ${b.year})`);
  }

  const audioA = a.tracks?.[0]?.bpm;
  const audioB = b.tracks?.[0]?.bpm;
  if (audioA != null && audioB != null && Math.abs(audioA - audioB) <= 8) {
    reasons.push(`similar tempo (${audioA} / ${audioB} bpm)`);
  }

  return {
    score: Number(similarity(a, b).toFixed(3)),
    reasons: reasons.length > 0 ? reasons : ['weak overall similarity'],
  };
}

export function explainPick(pick, context, similarity) {
  if (!pick) return null;
  return {
    pick: pick.id,
    why: context ? explainSimilarity(context, pick, similarity) : { score: null, reasons: ['no context release'] },
  };
}
