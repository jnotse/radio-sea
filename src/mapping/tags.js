// Tags come in two kinds.
//
//   sound tags    describe the track itself: a genre looked up for that
//                 recording, a Radiooooo mood or decade.
//   context tags  describe where it was heard: `station:`, `show:`, and
//                 `show-genre:` (the genres a station lists for a whole show).
//
// A show's genres say little about any single track in it: a guest set tagged
// "Jazz, Drum & Bass, UK Garage, Reggae" can be all jazz. So context may group
// tracks that were played together, but it never names their sound.

const CONTEXT_TAG = /^(station|show|show-genre):/;

export function isContextTag(tag) {
  return CONTEXT_TAG.test(tag);
}

/** Human-readable form of a tag ("decade:1970s" -> "1970s"). */
export function tagLabel(tag) {
  return String(tag).replace(/^(station|show|show-genre|decade|mood):/, '');
}
