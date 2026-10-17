"""Tests for scripts/wiki_facts.py: python3 -m unittest discover -s test -p 'test_*.py'"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import wiki_facts as wf  # noqa: E402

SOUL = ('Soul music is a popular music genre that originated in the African-American community throughout the '
        'United States in the late 1950s and early 1960s. It has its roots in African-American gospel music and rhythm and '
        'blues, and it combines elements of both with a strong rhythm section.')


class FakePage:
    def __init__(self, title, summary='', text=None, exists=True):
        self.title, self.summary, self.text, self._exists = title, summary, text or summary, exists
        self.fullurl = f'https://en.wikipedia.org/wiki/{title.replace(" ", "_")}'

    def exists(self):
        return self._exists


class FakeWiki:
    """Pages by title; redirects map a title to another page; anything else is missing."""
    def __init__(self, pages, redirects=None):
        self.pages, self.redirects, self.asked = pages, redirects or {}, []

    def page(self, title):
        self.asked.append(title)
        title = self.redirects.get(title, title)
        return self.pages.get(title) or FakePage(title, exists=False)


def wiki(*pages, redirects=None):
    return wf.Lookup(FakeWiki({p.title: p for p in pages}, redirects))


class SentenceTests(unittest.TestCase):
    def test_asides_are_dropped_and_abbreviations_kept(self):
        summary = ('Johann Sebastian Bach (31 March 1685 – 28 July 1750) was a German composer. '
                   'He was born in Eisenach, in what is now the U.S. state of nothing. J. S. Bach wrote fugues.')
        self.assertEqual(wf.sentences(summary)[0], 'Johann Sebastian Bach was a German composer.')
        self.assertIn('U.S. state', wf.sentences(summary)[1])
        self.assertEqual(wf.sentences(summary)[2], 'J. S. Bach wrote fugues.')

    def test_the_second_sentence_joins_when_both_fit_a_bubble(self):
        kuduro = 'Kuduro (or kuduru) is a type of music and dance born in Angola. It is characterized as uptempo, energetic, and danceable.'
        self.assertEqual(wf.fact_text(kuduro), 'Kuduro is a type of music and dance born in Angola. It is characterized as uptempo, energetic, and danceable.')
        self.assertEqual(wf.fact_text(SOUL), SOUL.split('. It has')[0] + '.')
        self.assertLessEqual(len(wf.fact_text(SOUL)), wf.MAX_LENGTH)


class GenreTests(unittest.TestCase):
    def test_genres_find_their_music_article_through_aliases_and_redirects(self):
        lookup = wiki(FakePage('Doo-wop', 'Doo-wop is a subgenre of rhythm and blues music that originated in the late 1940s.'),
                      redirects={'Doo wop music': 'Doo-wop'})
        self.assertEqual(lookup.genre('doo wop')['title'], 'Doo-wop')
        self.assertEqual(lookup.genre('doo wop')['url'], 'https://en.wikipedia.org/wiki/Doo-wop')

    def test_a_discogs_double_genre_uses_its_first_part_and_stage_and_screen_says_nothing(self):
        lookup = wiki(FakePage('Funk', 'Funk is a music genre that originated in African-American communities in the mid-1960s.'),
                      FakePage('Soul music', SOUL))
        self.assertEqual(lookup.genre('funk / soul')['title'], 'Funk')
        self.assertIsNone(lookup.genre('stage & screen'))

    def test_disambiguation_and_non_music_articles_are_skipped(self):
        lookup = wiki(FakePage('Minimal', 'Minimal may refer to: Minimal music, Minimal techno.'),
                      FakePage('Minimal techno', 'Minimal techno is a minimalist subgenre of techno music.'),
                      FakePage('Ghetto', 'A ghetto is a part of a city in which members of a minority group live.'))
        self.assertEqual(lookup.genre('minimal')['title'], 'Minimal techno')
        self.assertIsNone(lookup.genre('ghetto'), 'the article about city districts is not about music')


class ArtistTests(unittest.TestCase):
    def test_a_full_multi_word_name_is_trusted(self):
        lookup = wiki(FakePage('Lorez Alexandria', 'Lorez Alexandria (August 14, 1929 – May 22, 2001) was an American jazz singer.'))
        self.assertEqual(lookup.artist('Lorez Alexandria', ['Baltimore Oriole'])['text'], 'Lorez Alexandria was an American jazz singer.')

    def test_a_common_word_needs_the_article_to_name_their_music(self):
        death = FakePage('Death', 'Death is the end of life.')
        metal = FakePage('Death (band)', 'Death was an American death metal band.', text='Death was an American death metal band. Scream Bloody Gore.')
        self.assertIsNone(wiki(death, metal).artist('Death', ['Keep on Knocking', '...For the Whole World to See']))
        solar = FakePage('Solar (band)', 'Solar is a Dutch electronic duo.', text='Solar is a Dutch electronic duo. Their single "Your Secret" charted.')
        self.assertEqual(wiki(solar).artist('Solar', ['Your Secret'])['title'], 'Solar (band)')

    def test_a_shared_credit_falls_back_to_the_first_artist(self):
        bug = FakePage('The Bug (musician)', 'Kevin Martin, known as The Bug, is a British musician and producer.',
                       text='Kevin Martin is a British musician. Deep in a Mud is a single.')
        self.assertEqual(wiki(bug).artist('The Bug, Magugu', ['Deep In a Mud'])['title'], 'The Bug (musician)')
        self.assertEqual(wf.artist_names('Earth, Wind & Fire'), ['Earth, Wind & Fire', 'Earth'], 'the whole credit is tried first')


class RunTests(unittest.TestCase):
    sea = {'releases': [
        {'artist': 'Lorez Alexandria', 'name': 'Baltimore Oriole', 'tags': ['jazz', 'station:nts', 'mood:slow', 'channel:4AD']},
        {'artist': 'Solar', 'name': 'Your Secret', 'album': 'Solar', 'tags': ['new wave']},
    ]}

    def test_only_the_songs_own_genres_are_looked_up_and_every_answer_is_kept(self):
        genres, artists = wf.map_contents(self.sea)
        self.assertEqual(genres, ['jazz', 'new wave'])
        self.assertEqual(artists['Solar'], ['Solar', 'Your Secret'])
        saves = []
        cache = wf.run(wiki(FakePage('Jazz', 'Jazz is a music genre that originated in New Orleans.')), self.sea,
                       {'genres': {}, 'artists': {}}, save=lambda c: saves.append(json.dumps(c)), log=lambda *_: None)
        self.assertEqual(cache['genres']['jazz']['title'], 'Jazz')
        self.assertIsNone(cache['genres']['new wave'], 'nothing found is remembered too')
        self.assertTrue(saves)

    def test_reruns_ask_only_about_what_is_new_unless_retrying(self):
        cache = {'genres': {'jazz': {'title': 'Jazz', 'url': 'u', 'text': 't'}, 'new wave': None},
                 'artists': {'Lorez Alexandria': None, 'Solar': None}}
        fake = FakeWiki({})
        wf.run(wf.Lookup(fake), self.sea, cache, log=lambda *_: None)
        self.assertEqual(fake.asked, [])
        wf.run(wf.Lookup(fake), self.sea, cache, retry_missing=True, limit=1, log=lambda *_: None)
        self.assertTrue(fake.asked and fake.asked[0].startswith('New wave'))


@unittest.skipUnless(importlib.util.find_spec('wikipediaapi') and importlib.util.find_spec('httpx'), 'needs pip install -r requirements.txt')
class WikipediaApiTests(unittest.TestCase):
    def test_the_real_client_follows_redirects_to_the_article(self):
        import httpx
        info = {'query': {'redirects': [{'from': 'Doo wop', 'to': 'Doo-wop'}], 'pages': {'95164': {
            'pageid': 95164, 'ns': 0, 'title': 'Doo-wop', 'fullurl': 'https://en.wikipedia.org/wiki/Doo-wop'}}}}
        extracts = {'query': {'redirects': [{'from': 'Doo wop', 'to': 'Doo-wop'}], 'pages': {'95164': {
            'pageid': 95164, 'ns': 0, 'title': 'Doo-wop',
            'extract': 'Doo-wop (also spelled doowop) is a subgenre of rhythm and blues music.\n\n== History ==\nIt began in the 1940s.'}}}}
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=info if request.url.params.get('prop') == 'info' else extracts))
        lookup = wf.Lookup(wf.make_wiki(transport=transport, proxy=None))
        self.assertEqual(lookup.page('Doo wop')[:2], ('Doo-wop', 'https://en.wikipedia.org/wiki/Doo-wop'))
        self.assertEqual(lookup.genre('doo wop')['text'], 'Doo-wop is a subgenre of rhythm and blues music.')


if __name__ == '__main__':
    unittest.main()
