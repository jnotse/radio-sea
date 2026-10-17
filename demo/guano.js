/* Guano the guanaco, who walks the steppe to whatever is playing.
 *
 * Every sprite is drawn as text, one character per pixel (see PALETTE), so
 * the art can be read and touched up right here. Map frames are 24 × 24 and
 * face right; they are mirrored to face left. The face is 32 × 32. He comes
 * from a souvenir plush made in Magallanes, Chile. */
(() => {
  const PALETTE = {
    o: '#3a261e',                               // outline
    t: '#c48a45', l: '#deb068', d: '#9a6630',   // caramel coat, sunlit, in shade
    w: '#f7f0e4', s: '#d6cab6',                 // white fleece, in shade
    f: '#f0e8dc', g: '#cdc1b0',                 // felt face and hooves, in shade
    e: '#c4bab8',                               // felt inside the ears
    k: '#18141a', h: '#ffffff',                 // button eyes and nose, their glint
    m: '#281e24',                               // stitched smile
    r: '#ba343a',                               // embroidery on his chest
    n: '#f0a05a', b: '#a7dbea',                 // music notes, sleepy z's
  };

  const SPRITES = {
    idle0: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffhkffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggoggoooooggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    idle1: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffffffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.ooo...o....otttwwsoo...',
      'ollloooloooootttwwo.....',
      'odttolltlllllttwwwoo....',
      '.ottlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggoggoooooggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    walk0: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffhkffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswso.....',
      '..odtttttttttttlso......',
      '...otttwwwwwsdttso......',
      '...osttsssssoottso......',
      '...ogggooooo.ogggo......',
      '...ogggo.....ogggo......',
      '....ooo.......ooo.......',
    ],
    walk1: [
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffhkffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttssso.....',
      '..ottttttttttttloo......',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggottoooooggosso.....',
      '..oggoggo...oggoggo.....',
      '...oooggo....oooggo.....',
      '......oo........oo......',
    ],
    walk2: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffhkffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttsswo.....',
      '.osttttttttttttlosso....',
      '.ossddsttwwwttdoosso....',
      '.ossooottssstto.osso....',
      '.oggo.oggoooggo.oggo....',
      '.oggo.oggo.oggo.oggo....',
      '..oo...oo...oo...oo.....',
    ],
    walk3: [
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffhkffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttssso.....',
      '..ottttttttttttloo......',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..ossoggooooottoggo.....',
      '..oggoggo...oggoggo.....',
      '..oggooo....oggooo......',
      '...oo........oo.........',
    ],
    listen0: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggoggoooooggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    listen1: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '.......o....otttlggggo..',
      '.ooo.ooloooootttwwooo...',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttssso.....',
      '..ottttttttttttloo......',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..ossottooooottosso.....',
      '..oggoggo...oggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    dance0: [
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.ooo...o....otttwwsoo...',
      'ollloooloooootttwwo.....',
      'odttolltlllllttwwwoo....',
      '.ottlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsdggsso.....',
      '..ossottssssooggsso.....',
      '..oggoggoooo..ooggo.....',
      '..oggoggo......oggo.....',
      '...oo.oo........oo......',
    ],
    dance1: [
      '........................',
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '.......o....otttlggggo..',
      '.ooo.ooloooootttwwooo...',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggoggoooooggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    dance2: [
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.ooo...o....otttwwsoo...',
      'ollloooloooootttwwo.....',
      'odttolltlllllttwwwoo....',
      '.ottlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttssso.....',
      '..ottttttttttttloo......',
      '..ostdttwwwwsttsso......',
      '..ossottssssottggo......',
      '..ossottooooottggo......',
      '..oggoggo...oggoo.......',
      '..oggoggo...oggo........',
      '...oo.oo.....oo.........',
    ],
    dance3: [
      '........................',
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttfffkffhko',
      '...........otttffkfkfkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '.......o....otttlggggo..',
      '.ooo.ooloooootttwwooo...',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttswwo.....',
      '..ottttttttttttlsso.....',
      '..ostdttwwwwsttosso.....',
      '..ossottssssottosso.....',
      '..oggoggoooooggoggo.....',
      '..oggoggo...oggoggo.....',
      '...oo.oo.....oo.oo......',
    ],
    rest0: [
      '........................',
      '........................',
      '........................',
      '........................',
      '.............oo.oo......',
      '............ollolloo....',
      '............otelttllo...',
      '............otetttttlo..',
      '...........oltltffffffo.',
      '...........otttffffffhko',
      '...........otttffkkffkko',
      '...........odttffffffffo',
      '............ottlffffmmo.',
      '............otttlggggo..',
      '.......o....otttwwsoo...',
      '.ooo.ooloooootttwwo.....',
      'olllolltlllllttwwwoo....',
      'odttlttttttttttwwwwso...',
      '.otttttttttttttwwwwo....',
      '.odttttttttttttwwwso....',
      '..ottttttttttttssso.....',
      '..odtttttttttttloo......',
      '...oddswwwwwsddo........',
      '....ooffssssoffo........',
    ],
    face: [
      '................................',
      '......oo....oo..oo.....oo.......',
      '.....ollo..olloolloo..ollo......',
      '....olttlooottllttlloolttlo.....',
      '....ottetollttttttttlotetto.....',
      '....ottetltttttttttttltetto.....',
      '....ottetttttttttttttttetto.....',
      '....ottltttttttttttttttltto.....',
      '....otttttttftfttffttttttto.....',
      '....odttttfffffffffffttttdo.....',
      '.....ottthkfffffffffhkttto......',
      '.....otttkkfffffffffkkttto......',
      '.....odtfkkfffkkkfffkkftdo......',
      '......otfffffkhkkkfffffto.......',
      '......otfffffkkkkkfffffto.......',
      '......odffffffkkkffffffdo.......',
      '.......olffffffmfffffflo........',
      '........offmfffmfffmffo.........',
      '.........offmmmmmmmffo..........',
      '.........olgggggggggllo.........',
      '.........otlwgggggwwtto.........',
      '.........ottwwwwwwwwtto.........',
      '.........ottwwwwwwwwtto.........',
      '.........ottwwwwwwwwtto.........',
      '.........otswwwwwwwwtto.........',
      '.........ottwwwwwwrwrto.........',
      '........oowwwwwwwwwrsto.........',
      '......oolwwwwwwwwwwwwwloo.......',
      '.....ollwwwwwwwwwwwwwwwllo......',
      '....olttwwwwwwwwwwwwwwwttlo.....',
      '...oltttswwwwwwwwwswwwstttlo....',
      '...oddddlssssssssssssslddddo....',
    ],
    note: [
      '.....oo..',
      '....onno.',
      '....onono',
      '....onoo.',
      '....ono..',
      '...oono..',
      '..onnno..',
      '.onnnno..',
      '..onno...',
      '...oo....',
      '.........',
    ],
    zz: [
      '.........',
      '..ooooo..',
      '.obbbbbo.',
      '..ooobo..',
      '...obo...',
      '..obooo..',
      '.obbbbbo.',
      '..ooooo..',
      '.........',
    ],
  };

  // Upbeat songs get a little dance, calm ones a closed-eyed vibe. A known
  // tempo decides; otherwise the song's own genres do (or, for songs without
  // any, the genres of the show they were played on).
  const DANCE = /house|techno|disco|funk|boogie|break|drum n bass|drum and bass|jungle|garage|dub|dancehall|reggae|ska|rocksteady|\belectro\b|edm|club|ghetto|hip hop|rap\b|grime|new wave|synth-?pop|punk|krautrock|minimal|twist|rock & roll|latin|cha-cha|samba|afrobeat|footwork|juke|trance|italo|soca|cumbia|baile/;
  const CALM = /ambient|jazz|classical|romantic|baroque|opera|downtempo|folk|chanson|ballad|field recording|experimental|drone|new age|soundtrack|easy listening|piano|lo-fi|lounge|vocal|choral|chamber|sonata|spiritual/;
  function grooves({ genres = [], showGenres = [], bpm = null } = {}) {
    if (bpm > 0) return bpm >= 100 ? 'dance' : 'vibe';
    const tags = (genres.length ? genres : showGenres).map((t) => String(t).toLowerCase());
    const count = (pattern) => tags.filter((t) => pattern.test(t)).length;
    return count(DANCE) > count(CALM) ? 'dance' : 'vibe';
  }

  /** The frame for a mood at a moment: walk, dance, vibe, rest or idle. */
  function frame(mood, ms, { bpm = null, still = false } = {}) {
    const t = still ? 0 : ms;
    if (mood === 'walk') return `walk${Math.floor(t / 110) % 4}`;
    // Dance: a hoof tap, a nod, a hop, a nod; two moves to the beat.
    if (mood === 'dance') return `dance${Math.floor(t / (30000 / (bpm || 120))) % 4}`;
    if (mood === 'vibe') return `listen${Math.floor(t / (60000 / (bpm || 80))) % 2}`;
    if (mood === 'rest') return 'rest0';
    return t % 3400 > 3220 ? 'idle1' : 'idle0';   // a blink now and then
  }

  /** Notes rising while he listens, z's while he rests; sprite pixels from his top left, facing right. */
  function particles(mood, ms, { still = false } = {}) {
    const name = mood === 'dance' || mood === 'vibe' ? 'note' : mood === 'rest' ? 'zz' : null;
    if (!name) return [];
    const period = name === 'note' ? 2000 : 2800;
    return [0, period / 2].flatMap((phase, i) => {
      const p = still ? 0.3 + i * 0.3 : Math.floor((((ms + phase) % period) / period) * 10) / 10;
      if (p < 0.1 || p > 0.9) return [];
      return [{ name, id: i, x: (name === 'note' ? 17 : 18) + Math.round(p * 5) - i * 5, y: (name === 'note' ? -4 : 1) - Math.round(p * 14) }];
    });
  }

  /** Milliseconds until his picture next changes. */
  function wait(mood, ms, { bpm = null } = {}) {
    if (mood === 'walk') return 16;
    if (mood === 'dance') return Math.min(200, 30000 / (bpm || 120));
    if (mood === 'vibe') return 200;
    if (mood === 'rest') return 280;
    const t = ms % 3400;
    return (t <= 3220 ? 3220 : 3400) - t + 1;
  }

  // Each sprite becomes a small canvas the first time it is needed.
  const canvases = new Map();
  function sprite(name, flip = false) {
    const key = `${name}${flip ? ':flip' : ''}`;
    if (!canvases.has(key)) {
      const rows = SPRITES[name], canvas = document.createElement('canvas');
      canvas.width = rows[0].length; canvas.height = rows.length;
      const g = canvas.getContext('2d');
      rows.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return;
        g.fillStyle = PALETTE[ch];
        g.fillRect(flip ? canvas.width - 1 - x : x, y, 1, 1);
      }));
      canvases.set(key, canvas);
    }
    return canvases.get(key);
  }
  function drawFace(canvas) {
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(sprite('face'), 0, 0, canvas.width, canvas.height);
  }

  window.Guano = { PALETTE, SPRITES, grooves, frame, particles, wait, sprite, drawFace };
})();
