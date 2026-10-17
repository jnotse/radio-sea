// Tags come in three kinds.
//
//   genre tags       name a musical genre or style ("deep house", "hard bop").
//                    Eligible to name an island on the map.
//   descriptor tags  describe musical or physical attributes of the track:
//                    `mood:`, `decade:`, `inst:` (instrument), `credit:`
//                    (producer/remixer/arranger), and `format:` (12", 7", LP).
//                    Count as sound signals, but do not name genre islands.
//   context tags     describe where it was heard or curated: `station:`,
//                    `show:`, `show-genre:`, `channel:` (digger uploader),
//                    and `city:` (broadcast location).
//
// A show's genres say little about any single track in it: a guest set tagged
// "Jazz, Drum & Bass, UK Garage, Reggae" can be all jazz. So context may group
// tracks that were played together, but it never names their sound.

const CONTEXT_TAG = /^(station|show|show-genre|channel|city):/;
const DESCRIPTOR_TAG = /^(mood|decade|inst|credit|format):/;

export function isContextTag(tag) {
  return CONTEXT_TAG.test(tag);
}

export function isDescriptorTag(tag) {
  return DESCRIPTOR_TAG.test(tag);
}

export function isGenreTag(tag) {
  return !isContextTag(tag) && !isDescriptorTag(tag);
}

/** Human-readable form of a tag ("decade:1970s" -> "1970s"). */
export function tagLabel(tag) {
  return String(tag).replace(/^(station|show|show-genre|channel|city|decade|mood|inst|credit|format):/, '');
}
