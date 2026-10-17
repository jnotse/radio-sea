import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// UI tests do not depend on YouTube being online or playable in CI. Actual
// embeds get a separate live smoke test. The fake API exercises player errors.
test.beforeEach(async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({
    contentType: 'text/javascript', body: `window.__transport={play:0,pause:0,stop:0,volume:75,time:42,duration:240,seeks:[],loads:[]};
    window.YT={Player:function(frame,opts){
      this.destroy=()=>frame.remove(); this.playVideo=()=>{window.__transport.play++};
      this.pauseVideo=()=>{window.__transport.pause++;opts.events.onStateChange({data:2})};
      this.stopVideo=()=>{window.__transport.stop++;window.__transport.time=0};
      this.setVolume=(v)=>{window.__transport.volume=v};
      this.loadVideoById=(id)=>{window.__transport.loads.push(id);window.__transport.time=0};
      this.getCurrentTime=()=>window.__transport.time;
      this.getDuration=()=>window.__transport.duration;
      this.seekTo=(seconds,allowAhead)=>{window.__transport.time=seconds;window.__transport.seeks.push({seconds,allowAhead})};
      window.__playerOptions=opts; opts.events.onReady({target:this});
    }}; window.onYouTubeIframeAPIReady();`,
  }));
  await page.route('https://www.youtube.com/embed/**', (route) => route.fulfill({ body: '<html>test player</html>', contentType: 'text/html' }));
});

test('loaded snapshot has complete records, no playlist, and working filters', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const total = await page.evaluate(() => window.SEA_DATA.releases.length);
  await expect(page.locator('#sea')).toHaveAttribute('data-matching', String(total));
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(page.locator('#map-status')).toBeHidden();
  expect(await page.evaluate(() => window.SEA_DATA.releases.every((r) =>
    r.station && /^[\w-]{11}$/.test(r.youtubeId) && r.sourceUrl))).toBe(true);
  // Sources are not listed or filtered (there will be more); each song says where it was heard.
  await expect(page.locator('[data-station]')).toHaveCount(0);
  await expect(page.locator('#stats')).not.toContainText(/NTS|Lot Radio|Radiooooo/);
  // Genre filters read as genres.
  expect(await page.locator('#tag-chips').innerText()).not.toMatch(/mood:|decade:|show/);
  await expect(page.locator('#d-sources a').first()).toHaveAttribute('href', /https:\/\/(www\.)?(nts\.live|thelotradio\.com)\/(?!api)/);
  expect(await page.locator('#detail').innerText()).not.toContain('undefined');
  expect(await page.locator('#d-meta').innerText()).not.toMatch(/depth|~|Show tagged/);
  const genre = page.locator('#tag-chips button').first();
  const tag = await genre.getAttribute('data-tag');
  await genre.click();
  const tagged = await page.evaluate((t) => window.SEA_DATA.releases.filter((r) => r.tags.includes(t)).length, tag);
  await expect(page.locator('#sea')).toHaveAttribute('data-matching', String(tagged));
  await expect(page.locator('#map-status')).toContainText(`${tagged} of ${total}`);
  await page.locator('#search').fill('no song is called this');
  await expect(page.locator('#map-status')).toContainText('No matches');
  await expect(page.locator('#btn-banger')).toBeDisabled();
  await page.locator('#btn-clear').click();
  await expect(page.locator('#sea')).toHaveAttribute('data-matching', String(total));
  await expect(page.locator('#map-status')).toBeHidden();
  await page.locator('#btn-topology').click();
  await expect(page.locator('#sea')).toHaveAttribute('data-view', '3d');
  await expect(page.locator('#btn-topology')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#btn-topology').click();
  await expect(page.locator('#sea')).toHaveAttribute('data-view', '2d');
  expect(errors).toEqual([]);
});

test('search lists only matching songs, and picking a result or a neighbour plays it', async ({ page }) => {
  await page.goto('/');
  const total = await page.evaluate(() => window.SEA_DATA.releases.length);
  const track = await page.evaluate(() => window.SEA_DATA.releases.at(-1));
  await page.locator('#search').fill(track.artist);
  await expect(page.locator('#search-results')).toBeVisible();
  await expect(page.locator('#search-count')).toContainText('found');
  const count = await page.locator('#search-results button').count();
  expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(total);
  await page.locator(`#search-results button[data-track-id="${track.id}"]`).click();
  await expect(page.locator('#d-title')).toHaveText(track.name);
  await expectPlaying(page, track.id);
  const next = await page.locator('#d-neighbours b').first().textContent();
  await clickAfterScrolling(page, page.locator('#d-neighbours button').first());
  await expect(page.locator('#d-title')).toHaveText(next.split(' — ').slice(1).join(' — '));
  await page.locator('#search').fill('no-such-song-xyz');
  await expect(page.locator('#search-count')).toHaveText('Nothing found');
  await expect(page.locator('#map-status')).toContainText('No matches');
  await page.locator('#btn-clear').click();
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(page.locator('#btn-banger')).toBeEnabled();
});

// The player panel scrolls, and the YouTube frame sits at its top. Clicked
// straight after a scroll, Chromium can deliver the click to where that frame
// was before the scroll was painted, so let a frame paint first.
async function clickAfterScrolling(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await locator.click();
}

test('2D pan and zoom survive switching to 3D and back', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('#sea');
  await page.locator('#zoom-in').click();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 55, rect.y + rect.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  const camera = () => canvas.evaluate((el) => ({ x: el.dataset.cameraX, y: el.dataset.cameraY, zoom: el.dataset.zoom }));
  const before = await camera();
  await page.locator('#btn-topology').click();
  await page.locator('#zoom-in').click();
  await page.locator('#btn-topology').click();
  await expect(canvas).toHaveAttribute('data-view', '2d');
  expect(await camera()).toEqual(before);
});

async function screenPoint(page, id) {
  return page.evaluate((trackId) => {
    const c = document.querySelector('#sea'), rect = c.getBoundingClientRect();
    const r = window.SEA_DATA.releases.find((r) => r.id === trackId);
    return { x: rect.x + rect.width / 2 + (r.x - Number(c.dataset.cameraX)) * Number(c.dataset.zoom),
      y: rect.y + rect.height / 2 + (r.y - Number(c.dataset.cameraY)) * Number(c.dataset.zoom) };
  }, id);
}

test('wheel zoom is continuous, drag does not select, hover works after drag, tile clicks play', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('#sea');
  const initial = Number(await canvas.getAttribute('data-zoom'));
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, -80);
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(initial);
  const zoom = Number(await canvas.getAttribute('data-zoom'));
  expect(zoom / initial).toBeLessThan(1.5);
  const selected = await canvas.getAttribute('data-selected');
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 60, rect.y + rect.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect(canvas).toHaveAttribute('data-selected', selected);
  await expect(page.locator('#youtube-player')).toHaveCount(0);
  await page.locator('#btn-home').click();
  const id = await page.evaluate(() => window.SEA_DATA.releases.find((r) => r.id !== document.querySelector('#sea').dataset.selected).id);
  const p = await screenPoint(page, id);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('#tooltip')).toBeVisible();
  await page.mouse.click(p.x, p.y);
  await expect(canvas).toHaveAttribute('data-selected', id);
  await expectPlaying(page, id);
});

// Clicking a square on the map plays it, not just selects it.
async function expectPlaying(page, id) {
  const videoId = await page.evaluate((trackId) => window.SEA_DATA.releases.find((r) => r.id === trackId).youtubeId, id);
  await expect(page.locator('#youtube-player')).toHaveAttribute('src', new RegExp(`embed/${videoId}\\?`));
  await expect.poll(() => page.evaluate(() => window.__transport?.play ?? 0)).toBeGreaterThan(0);
}

test('player uses a real video ID, supplies origin/referrer and exposes a working fallback', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#d-player iframe')).toHaveCount(0);
  await page.locator('#video-poster').click();
  const iframe = page.locator('#d-player iframe');
  await expect(iframe).toHaveAttribute('src', /embed\/[\w-]{11}\?.*origin=http/);
  await expect(iframe).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(page.locator('#player-status')).toContainText('If nothing plays');
  await page.evaluate(() => window.__playerOptions.events.onError({ data: 150 }));
  await expect(page.locator('#player-status')).toContainText('error 150');
  await expect(page.locator('#d-youtube')).toHaveAttribute('href', /youtube\.com\/watch\?v=[\w-]{11}/);
});

test('responsive layout keeps the map and detail accessible on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const map = await page.locator('#sea').boundingBox();
  expect(map.width).toBeGreaterThan(300); expect(map.height).toBeGreaterThan(300);
  await page.locator('#detail').scrollIntoViewIfNeeded();
  await expect(page.locator('#d-title')).toBeVisible();
});

test.describe('touch-screen layout and controls', () => {
  test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 412, height: 915 }, { width: 768, height: 1024 }, { width: 932, height: 430 }]) {
    test(`fits ${size.width}×${size.height} without clipped content or small controls`, async ({ page }) => {
      await page.setViewportSize(size); await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Explore sections' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      for (const selector of ['#map-panel', '#detail', '#sidebar', '.mobile-nav']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      }
      const map = await page.locator('#sea').boundingBox();
      expect(map.width).toBeGreaterThan(230); expect(map.height).toBeGreaterThan(145);
      for (const selector of ['#zoom-in', '#zoom-out', '#btn-home', '#transport-prev', '#transport-play', '#transport-next', '#player-seek',
        '#player-volume', '#search', '#btn-banger', '#btn-clear', '#tag-chips button:first-child']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(44);
      }
      for (const selector of ['#search']) {
        expect(await page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      }
      const nav = await page.locator('.mobile-nav').boundingBox();
      expect(nav.y + nav.height).toBeCloseTo(size.height, 0);
    });
  }

  test('section shortcuts, search, playback and native touch seeking work on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Explore sections' });
    await nav.getByRole('link', { name: 'Explore' }).tap();
    await expect.poll(() => page.locator('#sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(8);
    const track = await page.evaluate(() => window.SEA_DATA.releases.at(-1));
    await page.locator('#search').fill(track.artist);
    await page.locator(`#search-results button[data-track-id="${track.id}"]`).tap();
    await expect(page.locator('#d-title')).toHaveText(track.name);
    await nav.getByRole('link', { name: 'Player' }).tap();
    await expect.poll(() => page.locator('#detail').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(8);
    await expect(page.locator('#player-seek')).toBeEnabled();
    await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
    await page.getByRole('button', { name: 'Pause', exact: true }).tap();
    const slider = page.locator('#player-seek'), box = await slider.boundingBox();
    await slider.tap({ position: { x: box.width * .6, y: box.height / 2 } });
    await expect.poll(() => page.evaluate(() => window.__transport.seeks.length)).toBeGreaterThan(0);
    const seconds = await page.evaluate(() => window.__transport.seeks.at(-1).seconds);
    expect(Math.abs(seconds - 144)).toBeLessThan(10);
    await expect(page.locator('#deck-state')).toHaveText('PAUSE');
    const position = await slider.inputValue();
    await nav.getByRole('link', { name: 'Map' }).tap();
    await expect(page.locator('#sea')).toBeInViewport();
    const zoom = Number(await page.locator('#sea').getAttribute('data-zoom'));
    await page.locator('#zoom-in').tap();
    await expect.poll(async () => Number(await page.locator('#sea').getAttribute('data-zoom'))).toBeGreaterThan(zoom);
    await page.setViewportSize({ width: 844, height: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
    await expect(nav).toBeInViewport();
    await expect(page.locator('#player-seek')).toHaveValue(position);
  });


  test('real multi-touch pinch and drag do not select tracks, and cancelled gestures recover', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
    const canvas = page.locator('#sea'), box = await canvas.boundingBox();
    const selected = await canvas.getAttribute('data-selected');
    const zoom = Number(await canvas.getAttribute('data-zoom'));
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const cdp = await context.newCDPSession(page);
    const touch = (id, x, y) => ({ id, x, y, radiusX: 5, radiusY: 5, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(1, x - 35, y), touch(2, x + 35, y)] });
    for (const distance of [45, 55, 65, 70]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, x - distance, y), touch(2, x + distance, y)] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(zoom * 1.8);
    expect(Number(await canvas.getAttribute('data-zoom'))).toBeLessThan(zoom * 2.2);
    await expect(canvas).toHaveAttribute('data-selected', selected);
    await expect(page.locator('#youtube-player')).toHaveCount(0);
    const cameraX = Number(await canvas.getAttribute('data-camera-x'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(1, x, y)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, x + 40, y + 24)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect.poll(async () => Number(await canvas.getAttribute('data-camera-x'))).not.toBe(cameraX);
    await expect(canvas).toHaveAttribute('data-selected', selected);
    await expect(canvas).not.toHaveClass(/dragging/);
    await page.locator('.mobile-nav a[href="#map-panel"]').tap();
    await page.locator('#btn-home').tap();
    const id = await page.evaluate(() => {
      const c = document.querySelector('#sea'), zoom = Number(c.dataset.zoom);
      return window.SEA_DATA.releases.find((r) => r.id !== c.dataset.selected &&
        Math.abs((r.x - Number(c.dataset.cameraX)) * zoom) < c.clientWidth / 2 - 45 &&
        Math.abs((r.y - Number(c.dataset.cameraY)) * zoom) < c.clientHeight / 2 - 90).id;
    });
    const point = await screenPoint(page, id);
    await page.touchscreen.tap(point.x, point.y);
    await expect(canvas).toHaveAttribute('data-selected', id);
    await expectPlaying(page, id);
    await cdp.detach();
  });
});

test('opening the HTML as a file explains the localhost requirement', async ({ page }) => {
  await page.goto(pathToFileURL(resolve('demo/index.html')).href);
  await expect(page.locator('#file-notice')).toBeVisible();
  await expect(page.locator('#video-poster')).toBeDisabled();
  await expect(page.locator('#transport-play')).toBeDisabled();
  await expect(page.locator('#player-seek')).toBeDisabled();
  await expect(page.locator('#d-youtube')).toHaveAttribute('href', /watch\?v=[\w-]{11}/);
});

test('next wanders to the nearest unheard song, previous goes back, play toggles pause, volume applies', async ({ page }) => {
  await page.goto('/');
  const sea = page.locator('#sea');
  const first = await sea.getAttribute('data-selected');
  const nearest = await page.evaluate((fromId) => {
    const all = window.SEA_DATA.releases, from = all.find((r) => r.id === fromId);
    const distance = (r) => Math.hypot(r.x - from.x, r.y - from.y);
    return all.filter((r) => r.id !== fromId).sort((a, b) => (b.islandId === from.islandId) - (a.islandId === from.islandId) ||
      distance(a) - distance(b) || a.id.localeCompare(b.id))[0];
  }, first);
  await expect(page.locator('#d-next b')).toHaveText(`${nearest.artist} — ${nearest.name}`);
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await expect(sea).toHaveAttribute('data-selected', nearest.id);
  await expectPlaying(page, nearest.id);
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  const third = await sea.getAttribute('data-selected');
  expect([first, nearest.id]).not.toContain(third);
  await page.getByRole('button', { name: 'Previous track', exact: true }).click();
  await expect(sea).toHaveAttribute('data-selected', nearest.id);
  await page.getByRole('button', { name: 'Previous track', exact: true }).click();
  await expect(sea).toHaveAttribute('data-selected', first);
  await expect(page.locator('#transport-prev')).toBeDisabled();
  await page.locator('#player-volume').focus();
  await page.locator('#player-volume').press('Home');
  await page.locator('#player-volume').press('ArrowRight');
  await expect(page.locator('#volume-value')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => window.__transport?.volume)).toBe(1);
  await page.evaluate(() => { window.__transport.time = 42; window.__playerOptions.events.onStateChange({ data: 1 }); });
  await expect(page.locator('#deck-state')).toHaveText('PLAY');
  await expect(page.locator('#deck-clock')).toHaveText('00:42');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#deck-state')).toHaveText('PAUSE');
  expect(await page.evaluate(() => window.__transport.pause)).toBe(1);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('Patagonia skin stays local and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('12px Silkscreen'))).toBe(true);
  const bg = await page.locator('#map-wrap').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(207, 165, 72)');
  await expect.poll(() => page.locator('#banner').evaluate((el) => el.width)).toBeGreaterThan(0);
  await page.locator('#transport-play').click();
  await expect(page.locator('#player-status')).toContainText('If nothing plays');
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
  expect(await page.locator('.spectrum i').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('seek knob previews a position without fighting the timer, then seeks on release', async ({ page }) => {
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Song position', exact: true });
  await expect(slider).toBeDisabled();
  await page.locator('#transport-play').click();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('max', '240');
  await expect(page.locator('#seek-readout')).toHaveText('00:42 / 04:00');
  await slider.evaluate((el) => { el.value = '83'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#seek-readout')).toHaveText('01:23 / 04:00');
  expect(await page.evaluate(() => window.__transport.seeks)).toEqual([]);
  await page.waitForTimeout(650); // Allow the 500ms playback sync to run during a drag.
  await expect(slider).toHaveValue('83');
  await slider.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  expect(await page.evaluate(() => window.__transport.seeks)).toEqual([{ seconds: 83, allowAhead: true }]);
});

test('touch range release commits without change and does not seek twice if change follows', async ({ page }) => {
  await page.goto('/'); await page.locator('#transport-play').click();
  const slider = page.locator('#player-seek'); await expect(slider).toBeEnabled();
  await slider.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    el.value = '83'; el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
  });
  expect(await page.evaluate(() => window.__transport.seeks)).toEqual([{ seconds: 83, allowAhead: true }]);
  await slider.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  expect(await page.evaluate(() => window.__transport.seeks.length)).toBe(1);
});

test('seek supports one-second keyboard steps and resets when switching tracks', async ({ page }) => {
  await page.goto('/'); await page.locator('#transport-play').click();
  const slider = page.locator('#player-seek');
  await expect(slider).toBeEnabled();
  await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  expect(await page.evaluate(() => window.__transport.seeks.at(-1).seconds)).toBe(1);
  // The next video's length is unknown until it loads.
  await page.evaluate(() => { window.__transport.duration = 0; });
  await page.locator('#transport-next').click();
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveValue('0');
  await expect(page.locator('#seek-readout')).toHaveText('00:00 / --:--');
});

test('seek stays disabled until a finite duration arrives', async ({ page }) => {
  await page.goto('/'); await page.locator('#transport-play').click();
  await expect(page.locator('#player-seek')).toBeEnabled();
  await page.evaluate(() => { window.__transport.duration = 0; });
  await expect(page.locator('#player-seek')).toBeDisabled();
  await page.evaluate(() => { window.__transport.duration = 360; });
  await expect(page.locator('#player-seek')).toBeEnabled();
  await expect(page.locator('#player-seek')).toHaveAttribute('max', '360');
});

test('a finished song plays the next one in the same player; unplayable videos are skipped a few times at most', async ({ page }) => {
  await page.goto('/');
  await page.locator('#transport-play').click();
  await expect(page.locator('#player-status')).toContainText('If nothing plays');
  const sea = page.locator('#sea');
  const videoOf = (id) => page.evaluate((trackId) => window.SEA_DATA.releases.find((r) => r.id === trackId).youtubeId, id);
  const event = (name, data) => page.evaluate(([n, d]) => window.__playerOptions.events[n]({ data: d }), [name, data]);
  // The song the player announces as up next is the one that follows.
  const upNext = () => page.evaluate(() => {
    const shown = document.querySelector('#d-next b')?.textContent;
    return window.SEA_DATA.releases.find((r) => `${r.artist} — ${r.name}` === shown)?.id;
  });

  let expected = await upNext();
  await event('onStateChange', 1);
  await event('onStateChange', 0);
  await expect(sea).toHaveAttribute('data-selected', expected);
  expect(await page.evaluate(() => window.__transport.loads)).toEqual([await videoOf(expected)]);
  await expect(page.locator('#youtube-player')).toHaveCount(1);
  await expect(page.locator('#d-youtube')).toHaveAttribute('href', new RegExp(await videoOf(expected)));

  // Embedding refused: skip ahead after a moment.
  expected = await upNext();
  await event('onError', 150);
  await expect(page.locator('#player-status')).toContainText('Skipping');
  await expect(sea).toHaveAttribute('data-selected', expected);
  await event('onStateChange', 1);

  // A blocked YouTube must not spin through the whole map.
  for (let i = 0; i < 5; i += 1) {
    expected = await upNext();
    await event('onError', 150);
    await expect(sea).toHaveAttribute('data-selected', expected);
  }
  await event('onError', 150);
  await expect(page.locator('#player-status')).toContainText('playback stopped');
  await page.waitForTimeout(2000);
  await expect(sea).toHaveAttribute('data-selected', expected);
});

// A song Guano dances to, or one he vibes to, other than the one already selected.
async function songFor(page, mood) {
  return page.evaluate((wanted) => window.SEA_DATA.releases.find((r) => r.id !== document.querySelector('#sea').dataset.selected &&
    window.Guano.grooves({ genres: (r.tags ?? []).filter((t) => !/^(show|station|show-genre|mood|decade):/.test(t)), bpm: r.bpm }) === wanted).id, mood);
}

test('G-digs: Guano trots to the song you press, dances or vibes while it plays, and lies down when paused', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle(/^G-digs/);
  await expect(page.locator('.brand h1')).toHaveText('G-digs');
  for (const face of await page.locator('canvas.guano-face').all()) {
    expect(await face.evaluate((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0))).toBe(true);
  }
  const canvas = page.locator('#sea');
  await expect(canvas).toHaveAttribute('data-guano', 'idle');
  await expect(page.locator('#guano-says')).toHaveText('Guano is waiting by this song.');

  const upbeat = await songFor(page, 'dance');
  await page.locator('#btn-home').click();
  const p = await screenPoint(page, upbeat);
  await page.mouse.click(p.x, p.y);
  await expect(canvas).toHaveAttribute('data-selected', upbeat);
  await expect(canvas).toHaveAttribute('data-guano', 'walk');
  await expect(page.locator('#guano-says')).toContainText('trotting over');
  await expect(canvas).not.toHaveAttribute('data-guano', 'walk', { timeout: 6000 });
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
  await expect(canvas).toHaveAttribute('data-guano', 'dance');
  await expect(page.locator('#guano-says')).toContainText('dancing');
  // He stands beside the song, on its ground line, facing it.
  const rect = await canvas.boundingBox(), song = await screenPoint(page, upbeat);
  const g = await canvas.evaluate((c) => ({ x: Number(c.dataset.guanoX), y: Number(c.dataset.guanoY), facing: c.dataset.guanoFacing }));
  const dx = g.x - (song.x - rect.x);
  expect(Math.abs(dx)).toBeGreaterThan(10); expect(Math.abs(dx)).toBeLessThan(50);
  expect(Math.abs(g.y - (song.y - rect.y))).toBeLessThan(14);
  expect(g.facing).toBe(dx > 0 ? 'left' : 'right');

  await page.locator('#transport-play').click();
  await expect(canvas).toHaveAttribute('data-guano', 'rest');
  await expect(page.locator('#guano-says')).toContainText('lay down');

  const calm = await songFor(page, 'vibe');
  const name = await page.evaluate((id) => window.SEA_DATA.releases.find((r) => r.id === id).name, calm);
  await page.locator('#search').fill(name);
  await page.locator(`#search-results button[data-track-id="${calm}"]`).click();
  await expect(canvas).not.toHaveAttribute('data-guano', 'walk', { timeout: 6000 });
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
  await expect(canvas).toHaveAttribute('data-guano', 'vibe');
  await expect(page.locator('#guano-says')).toContainText('vibing');
  expect(errors).toEqual([]);
});

test('with reduced motion Guano moves without walking; he is in the 3D view too', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const canvas = page.locator('#sea');
  const id = await songFor(page, 'dance');
  const name = await page.evaluate((trackId) => window.SEA_DATA.releases.find((r) => r.id === trackId).name, id);
  await page.locator('#search').fill(name);
  await page.locator(`#search-results button[data-track-id="${id}"]`).click();
  await expect(canvas).toHaveAttribute('data-selected', id);
  expect(await canvas.getAttribute('data-guano')).not.toBe('walk');
  await page.locator('#btn-topology').click();
  await expect(canvas).toHaveAttribute('data-view', '3d');
  const g = await canvas.evaluate((c) => ({ x: Number(c.dataset.guanoX), y: Number(c.dataset.guanoY), w: c.clientWidth, h: c.clientHeight }));
  expect(g.x).toBeGreaterThan(0); expect(g.x).toBeLessThan(g.w);
  expect(g.y).toBeGreaterThan(0); expect(g.y).toBeLessThan(g.h);
});

test('while a song plays, Guano tells a fact from Wikipedia, and the player credits it', async ({ page }) => {
  // Give one song's artist a fact before the map loads.
  await page.addInitScript(() => {
    let data;
    Object.defineProperty(window, 'SEA_DATA', { configurable: true, get: () => data, set: (value) => {
      const song = value.releases[1];
      value.facts = { genres: {}, artists: { [song.artist]: { title: 'Test Artist', url: 'https://en.wikipedia.org/wiki/Test_Artist',
        text: 'Test Artist is a band from the steppe that plays very long songs.' } } };
      window.__factSong = song.id; data = value;
    } });
  });
  await page.goto('/');
  const id = await page.evaluate(() => window.__factSong);
  const name = await page.evaluate((trackId) => window.SEA_DATA.releases.find((r) => r.id === trackId).name, id);
  await page.locator('#search').fill(name);
  await page.locator(`#search-results button[data-track-id="${id}"]`).click();
  const canvas = page.locator('#sea');
  await expect(canvas).not.toHaveAttribute('data-guano', 'walk', { timeout: 6000 });
  await expect(page.locator('#guano-bubble')).toBeHidden();
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
  await expect(page.locator('#guano-bubble')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#guano-bubble')).toContainText('plays very long songs');
  await expect(page.locator('#guano-fact')).toBeVisible();
  await expect(page.locator('#guano-fact-link')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Test_Artist');
  await expect(page.locator('#guano-fact-link')).toHaveText(/Wikipedia: Test Artist/);
  // The bubble stays inside the map, near Guano.
  const map = await page.locator('#map-wrap').boundingBox(), bubble = await page.locator('#guano-bubble').boundingBox();
  expect(bubble.x).toBeGreaterThanOrEqual(map.x); expect(bubble.x + bubble.width).toBeLessThanOrEqual(map.x + map.width);
  // Paused, he lies down and stops talking; the fact stays in the player.
  await page.locator('#transport-play').click();
  await expect(canvas).toHaveAttribute('data-guano', 'rest');
  await expect(page.locator('#guano-bubble')).toBeHidden();
  await expect(page.locator('#guano-fact')).toBeVisible();
});
