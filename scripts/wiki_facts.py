"""Short facts from Wikipedia for Guano to tell while a song plays.

    pip install -r requirements.txt
    npm run catalog:wiki            # or: python3 scripts/wiki_facts.py

Looks up each genre and artist on the map with Wikipedia-API, keeps the
opening sentence or two of the article when the article is really about that
music, and saves it with the article's link in data/wiki-facts.json. The map
is then rebuilt with them (npm run catalog:wiki does both).

Artist names are often ordinary words ("Death", "Solar", "War"), so an
artist's article is only trusted outright when its title is the full,
multi-word name; otherwise the article has to mention one of that artist's
songs, albums or labels. A wrong fact is worse than none.

Every lookup is saved, found or not, so a run that stops (or a rerun after the
map grows) only asks about what is new; --retry-missing asks again about the
ones that found nothing. Wikipedia's text is CC BY-SA 4.0: the site credits
and links every article it quotes.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FACTS_FILE = ROOT / 'data' / 'wiki-facts.json'
MAP_FILE = ROOT / 'demo' / 'sea-data.json'
USER_AGENT = 'g-digs/0.1 (https://github.com/jnotse/radio-sea)'
MAX_LENGTH = 220

# Discogs' broad genres name two or three genres at once; some say nothing.
SPLIT = {
    'funk / soul': ['funk', 'soul'],
    'folk, world, & country': ['folk', 'world music', 'country'],
    'brass & military': ['brass band', 'military music'],
    "children's": ["children's music"],
    'stage & screen': [],
    'non-music': [],
}
# Genre names whose article has another title.
ALIASES = {
    'ambient': 'Ambient music', 'breaks': 'Breakbeat', 'cha-cha': 'Cha-cha-chá', 'classical': 'Classical music',
    'country': 'Country music', 'darkwave': 'Dark wave', 'doo wop': 'Doo-wop', 'drum n bass': 'Drum and bass',
    'dub': 'Dub music', 'edm': 'Electronic dance music', 'electro': 'Electro (music)', 'electronic': 'Electronic music',
    'experimental': 'Experimental music', 'folk': 'Folk music', 'ghetto': 'Ghetto house', 'hip hop': 'Hip-hop',
    'house': 'House music', 'idm': 'Intelligent dance music', 'industrial': 'Industrial music', 'jungle': 'Jungle music',
    'latin': 'Latin music', 'lo-fi': 'Lo-fi music', 'minimal': 'Minimal techno', 'modern classical': 'Contemporary classical music',
    'new wave': 'New wave music', 'noise': 'Noise music', 'pop': 'Pop music', 'rhythm & blues': 'Rhythm and blues',
    'rock': 'Rock music', 'romantic': 'Romantic music', 'soul': 'Soul music', 'soul-jazz': 'Soul jazz',
    'trance': 'Trance music', 'world music': 'World music',
}
GENRE_WORDS = re.compile(r'\b(music|musical|genre|subgenre|style|dance|song|songs|rhythm|sound|singing|instrument\w*|record\w*)\b', re.I)
ARTIST_WORDS = re.compile(
    r'\b(band|bands|musician|singer|rapper|dj|disc jockey|producer|composer|songwriter|group|duo|trio|quartet|orchestra|'
    r'ensemble|guitarist|pianist|drummer|bassist|saxophonist|trumpeter|vocalist|conductor|recording artist|musical artist|'
    r'music project|hip hop|soundtrack)\b', re.I)
QUALIFIERS = ['band', 'musician', 'singer', 'rapper', 'DJ', 'producer', 'record producer', 'group', 'composer']
ABBREVIATIONS = re.compile(r'\b(?:[A-Z]|St|Dr|Mr|Mrs|Ms|Jr|Sr|vs|feat|No|Vol|Inc|Ltd|Co|ca|c|U\.S|U\.K|e\.g|i\.e|a\.k\.a)\.')


def plain(text):
    """Lower case without accents or punctuation, for comparing names."""
    text = unicodedata.normalize('NFKD', str(text)).encode('ascii', 'ignore').decode().lower()
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', text).split())


def capital(name):
    return name[:1].upper() + name[1:]


def sentences(summary):
    """The summary's sentences, without parenthetical asides (dates, pronunciations, other names)."""
    text = summary.split('\n')[0]
    while re.search(r'\([^()]*\)', text):
        text = re.sub(r'\s*\([^()]*\)', '', text)
    text = re.sub(r'\s+([,.;:])', r'\1', ' '.join(text.split()))
    guarded = ABBREVIATIONS.sub(lambda m: m.group(0).replace('.', '\0'), text)
    return [s.replace('\0', '.').strip() for s in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9"“‘])', guarded) if s.strip()]


def fact_text(summary):
    """The opening sentence, with the next one when both fit in a speech bubble."""
    found = [s for s in sentences(summary) if 20 <= len(s) <= MAX_LENGTH]
    if not found:
        return None
    text = found[0]
    if len(found) > 1 and len(text) + 1 + len(found[1]) <= MAX_LENGTH:
        text = f'{text} {found[1]}'
    return text


def disambiguation(summary):
    return bool(re.search(r'\bmay (also )?refer to\b', summary[:300], re.I))


def genre_titles(tag):
    """Article titles to try for one genre tag, most likely first."""
    titles = []
    for part in SPLIT.get(tag, [tag]):
        if part in ALIASES:
            titles.append(ALIASES[part])
        titles += [f'{capital(part)} music', capital(part), f'{capital(part)} (music)', f'{capital(part)} (genre)']
    return list(dict.fromkeys(titles))


def artist_names(credit):
    """The whole credit, then its first name ("The Bug, Magugu" → "The Bug")."""
    first = re.split(r',\s+|\s+(?:&|and|x|×|feat\.?|ft\.?|featuring|with)\s+', credit, flags=re.I)[0].strip()
    return list(dict.fromkeys(n for n in (credit.strip(), first) if n))


def artist_titles(name):
    return [name] + [f'{name} ({q})' for q in QUALIFIERS]


def mentions(text, works):
    """Does the article text name any of these songs, albums or labels?"""
    haystack = f' {plain(text)} '
    return any(len(w) >= 4 and f' {w} ' in haystack for w in (plain(work) for work in works))


class Lookup:
    def __init__(self, wiki, pause=0.0):
        self.wiki, self.pause = wiki, pause

    def page(self, title):
        """(title, url, summary, text) of an existing article, following redirects; else None."""
        if self.pause:
            time.sleep(self.pause)
        page = self.wiki.page(title)
        if not page.exists():
            return None
        summary = page.summary or ''
        if not summary or disambiguation(summary):
            return None
        return page.title, page.fullurl, summary, page.text or summary

    def genre(self, tag):
        for title in genre_titles(tag):
            found = self.page(title)
            if not found:
                continue
            name, url, summary, _ = found
            text = fact_text(summary)
            if text and GENRE_WORDS.search(' '.join(sentences(summary)[:2])):
                return {'title': name, 'url': url, 'text': text}
        return None

    def artist(self, credit, works):
        for name in artist_names(credit):
            distinctive = len([w for w in plain(name).split() if w not in ('the', 'a', 'an')]) >= 2
            for title in artist_titles(name):
                found = self.page(title)
                if not found:
                    continue
                page_title, url, summary, text = found
                fact = fact_text(summary)
                if not fact or not ARTIST_WORDS.search(' '.join(sentences(summary)[:2])):
                    continue
                exact = plain(page_title) == plain(name)
                if (exact and distinctive) or mentions(text, works):
                    return {'title': page_title, 'url': url, 'text': fact}
        return None


def map_contents(sea):
    """Genre tags and artists on the map, with each artist's songs, albums and labels."""
    context = re.compile(r'^(show|station|show-genre|mood|decade|channel):')
    genres, artists = set(), {}
    for r in sea['releases']:
        genres.update(t for t in r.get('tags', []) if not context.match(t))
        works = artists.setdefault(r['artist'], set())
        works.update(w for w in (r.get('name'), r.get('album'), r.get('label')) if w)
    return sorted(genres), {a: sorted(w) for a, w in sorted(artists.items())}


def make_wiki(language='en', **options):
    import wikipediaapi  # pip install -r requirements.txt
    # Behind an HTTPS proxy (as in some cloud machines), route through it explicitly.
    if os.environ.get('HTTPS_PROXY') and 'proxy' not in options:
        options['proxy'] = os.environ['HTTPS_PROXY']
        if os.environ.get('SSL_CERT_FILE'):
            options['verify'] = os.environ['SSL_CERT_FILE']
    return wikipediaapi.Wikipedia(user_agent=USER_AGENT, language=language,
                                  extract_format=wikipediaapi.ExtractFormat.WIKI,
                                  extra_api_params={'redirects': 1}, max_retries=5, retry_wait=2.0, timeout=30.0, **options)


def run(lookup, sea, cache, *, retry_missing=False, limit=None, save=lambda cache: None, log=print):
    genres, artists = map_contents(sea)
    todo = [('genres', g, None) for g in genres] + [('artists', a, works) for a, works in artists.items()]
    todo = [(kind, key, works) for kind, key, works in todo
            if key not in cache[kind] or (retry_missing and cache[kind][key] is None)]
    if limit is not None:
        todo = todo[:limit]
    for done, (kind, key, works) in enumerate(todo, 1):
        found = lookup.genre(key) if kind == 'genres' else lookup.artist(key, works)
        cache[kind][key] = found
        log(f'  {done}/{len(todo)} {kind[:-1]} {key}: {found["title"] if found else "nothing"}')
        if done % 10 == 0:
            save(cache)
    save(cache)
    return cache


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--retry-missing', action='store_true', help='ask again about genres and artists that found nothing')
    parser.add_argument('--limit', type=int, help='look up at most this many (a trial)')
    parser.add_argument('--pause', type=float, default=0.5, help='seconds to wait before each article (default 0.5)')
    args = parser.parse_args(argv)

    sea = json.loads(MAP_FILE.read_text())
    cache = {'genres': {}, 'artists': {}}
    if FACTS_FILE.exists():
        cache.update({k: v for k, v in json.loads(FACTS_FILE.read_text()).items() if k in ('genres', 'artists')})

    def save(current):
        payload = {'source': 'Wikipedia', 'license': 'CC BY-SA 4.0', 'language': 'en',
                   'checkedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), **current}
        FACTS_FILE.with_suffix('.json.next').write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        FACTS_FILE.with_suffix('.json.next').replace(FACTS_FILE)

    print('Looking up genres and artists on Wikipedia…')
    run(Lookup(make_wiki(), pause=args.pause), sea, cache, retry_missing=args.retry_missing, limit=args.limit, save=save)
    found = {kind: sum(1 for v in cache[kind].values() if v) for kind in ('genres', 'artists')}
    print(f"Saved data/wiki-facts.json: facts for {found['genres']}/{len(cache['genres'])} genres "
          f"and {found['artists']}/{len(cache['artists'])} artists.")


if __name__ == '__main__':
    sys.exit(main())
