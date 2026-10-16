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

test('loaded snapshot has complete track records and working filters', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const total = await page.evaluate(() => window.SEA_DATA.releases.length);
  await expect(page.locator('#track-list button')).toHaveCount(total);
  await expect(page.locator('#sea')).toHaveAttribute('data-matching', String(total));
  expect(await page.evaluate(() => window.SEA_DATA.releases.every((r) =>
    r.station && /^[\w-]{11}$/.test(r.youtubeId) && r.sourceUrl))).toBe(true);
  await expect(page.locator('[data-station="worldwidefm"]')).toBeDisabled();
  await expect(page.locator('#d-sources a').first()).toHaveAttribute('href', /https:\/\/(www\.)?(nts\.live|thelotradio\.com)\/(?!api)/);
  expect(await page.locator('#detail').innerText()).not.toContain('undefined');
  await page.locator('[data-station="nts"]').click();
  const remainingCount = await page.evaluate(() => window.SEA_DATA.releases.filter((r) => r.stations.some((s) => s !== 'nts')).length);
  await expect(page.locator('#track-list button')).toHaveCount(remainingCount);
  await page.locator('[data-station="lotradio"]').click();
  // Other sources (e.g. Radiooooo) may have been added since this snapshot.
  for (const chip of await page.locator('#station-chips button[aria-pressed="true"]:not(:disabled)').all()) await chip.click();
  await expect(page.locator('#map-status')).toContainText('No matches');
  await expect(page.locator('#btn-banger')).toBeDisabled();
  await page.locator('#btn-clear').click();
  await expect(page.locator('#track-list button')).toHaveCount(total);
  expect(errors).toEqual([]);
});

test('search, selecting neighbours, and similar navigation work without undefined errors', async ({ page }) => {
  await page.goto('/');
  const title = await page.locator('#d-title').textContent();
  await page.locator('#btn-similar').click();
  await expect(page.locator('#d-title')).not.toHaveText(title);
  const next = await page.locator('#d-neighbours b').first().textContent();
  await page.locator('#d-neighbours button').first().click();
  await expect(page.locator('#d-title')).toHaveText(next.split(' — ').slice(1).join(' — '));
  await page.locator('#search').fill('no-such-song-xyz');
  await expect(page.locator('#map-status')).toContainText('No matches');
  await page.locator('#btn-clear').click();
  await expect(page.locator('#btn-banger')).toBeEnabled();
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
  await page.locator('#play-track').click();
  const iframe = page.locator('#d-player iframe');
  await expect(iframe).toHaveAttribute('src', /embed\/[\w-]{11}\?.*origin=http/);
  await expect(iframe).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(page.locator('#player-status')).toContainText('ready');
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
      for (const selector of ['#zoom-in', '#zoom-out', '#transport-play', '#player-seek', '#player-volume', '#seek-time', '#seek-go',
        '#search', '#btn-banger', '#track-list li:first-child button', '#station-chips button:first-child', '#tag-chips button:first-child']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(44);
      }
      for (const selector of ['#search', '#seek-time']) {
        expect(await page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      }
      const nav = await page.locator('.mobile-nav').boundingBox();
      expect(nav.y + nav.height).toBeCloseTo(size.height, 0);
    });
  }

  test('section shortcuts, search, playback and native touch seeking work on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Explore sections' });
    await nav.getByRole('link', { name: '01 / Library' }).tap();
    await expect.poll(() => page.locator('#sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(8);
    const track = await page.evaluate(() => window.SEA_DATA.releases.at(-1));
    await page.locator('#search').fill(track.artist);
    await page.locator(`#track-list button[data-track-id="${track.id}"]`).tap();
    await expect(page.locator('#d-title')).toHaveText(track.name);
    await nav.getByRole('link', { name: '03 / Player' }).tap();
    await expect.poll(() => page.locator('#detail').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(8);
    await page.locator('#transport-play').tap();
    await expect(page.locator('#player-seek')).toBeEnabled();
    await page.locator('#transport-pause').tap();
    const slider = page.locator('#player-seek'), box = await slider.boundingBox();
    await slider.tap({ position: { x: box.width * .6, y: box.height / 2 } });
    await expect.poll(() => page.evaluate(() => window.__transport.seeks.length)).toBeGreaterThan(0);
    const seconds = await page.evaluate(() => window.__transport.seeks.at(-1).seconds);
    expect(Math.abs(seconds - 144)).toBeLessThan(10);
    await expect(page.locator('#deck-state')).toHaveText('PAUSE');
    await page.locator('#seek-time').fill('1:23'); await page.locator('#seek-go').tap();
    await expect(page.locator('#player-seek')).toHaveValue('83');
    await nav.getByRole('link', { name: '02 / Map' }).tap();
    await expect(page.locator('#sea')).toBeInViewport();
    const zoom = Number(await page.locator('#sea').getAttribute('data-zoom'));
    await page.locator('#zoom-in').tap();
    await expect.poll(async () => Number(await page.locator('#sea').getAttribute('data-zoom'))).toBeGreaterThan(zoom);
    await page.setViewportSize({ width: 844, height: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
    await expect(nav).toBeInViewport();
    await expect(page.locator('#player-seek')).toHaveValue('83');
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
    await page.locator('.mobile-nav a[href="#sidebar"]').tap();
    await page.locator('#btn-home').tap();
    await page.locator('.mobile-nav a[href="#map-panel"]').tap();
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
  await expect(page.locator('#play-track')).toBeDisabled();
  await expect(page.locator('#transport-play')).toBeDisabled();
  await expect(page.locator('#player-seek')).toBeDisabled();
  await expect(page.locator('#d-youtube')).toHaveAttribute('href', /watch\?v=[\w-]{11}/);
});

test('retro transport controls navigate, pause, stop and apply real player volume', async ({ page }) => {
  await page.goto('/');
  const first = await page.locator('#d-title').textContent();
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await expect(page.locator('#d-title')).not.toHaveText(first);
  await expect(page.locator('#deck-index')).toHaveText(/02 \/ \d+/);
  await page.getByRole('button', { name: 'Previous track', exact: true }).click();
  await expect(page.locator('#d-title')).toHaveText(first);
  await page.locator('#player-volume').focus();
  await page.locator('#player-volume').press('Home');
  await page.locator('#player-volume').press('ArrowRight');
  await expect(page.locator('#volume-value')).toHaveText('1');
  await page.getByRole('button', { name: 'Play selected track', exact: true }).click();
  await expect(page.locator('#youtube-player')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__transport?.volume)).toBe(1);
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 1 }));
  await expect(page.locator('#deck-state')).toHaveText('PLAY');
  await expect(page.locator('#deck-clock')).toHaveText('00:42');
  await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
  await expect(page.locator('#deck-state')).toHaveText('PAUSE');
  expect(await page.evaluate(() => window.__transport.pause)).toBe(1);
  await page.getByRole('button', { name: 'Stop playback', exact: true }).click();
  await expect(page.locator('#deck-state')).toHaveText('STOP');
  await expect(page.locator('#deck-clock')).toHaveText('00:00');
  expect(await page.evaluate(() => window.__transport.stop)).toBe(1);
});

test('pixel skin stays local and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('12px Silkscreen'))).toBe(true);
  const bg = await page.locator('#map-wrap').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(165, 184, 119)');
  await page.locator('#transport-play').click();
  await expect(page.locator('#player-status')).toContainText('ready');
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

test('jump accepts seconds or mm:ss, clamps to duration and preserves pause', async ({ page }) => {
  await page.goto('/'); await page.locator('#transport-play').click();
  await expect(page.locator('#seek-time')).toBeEnabled();
  await page.evaluate(() => window.__playerOptions.events.onStateChange({ data: 2 }));
  const playsBefore = await page.evaluate(() => window.__transport.play);
  await page.getByRole('textbox', { name: 'Jump time', exact: true }).fill('1:23');
  await page.locator('#seek-go').click();
  await expect(page.locator('#deck-clock')).toHaveText('01:23');
  await expect(page.locator('#deck-state')).toHaveText('PAUSE');
  expect(await page.evaluate(() => window.__transport.play)).toBe(playsBefore);
  await page.locator('#seek-time').fill('120s'); await page.locator('#seek-go').click();
  await expect(page.locator('#player-seek')).toHaveValue('120');
  await page.locator('#seek-time').fill('9999'); await page.locator('#seek-go').click();
  await expect(page.locator('#seek-readout')).toHaveText('04:00 / 04:00');
  const count = await page.evaluate(() => window.__transport.seeks.length);
  await page.locator('#seek-time').fill('1:90'); await page.locator('#seek-go').click();
  await expect(page.locator('#seek-message')).toBeVisible();
  expect(await page.evaluate(() => window.__transport.seeks.length)).toBe(count);
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
  await page.locator('#transport-next').click();
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveValue('0');
  await expect(page.locator('#seek-readout')).toHaveText('00:00 / --:--');
  await expect(page.locator('#seek-time')).toBeDisabled();
});

test('seek stays disabled until a finite duration arrives', async ({ page }) => {
  await page.goto('/'); await page.locator('#transport-play').click();
  await expect(page.locator('#player-seek')).toBeEnabled();
  await page.evaluate(() => { window.__transport.duration = 0; });
  await expect(page.locator('#player-seek')).toBeDisabled();
  await expect(page.locator('#seek-go')).toBeDisabled();
  await page.evaluate(() => { window.__transport.duration = 360; });
  await expect(page.locator('#player-seek')).toBeEnabled();
  await expect(page.locator('#player-seek')).toHaveAttribute('max', '360');
});

test('a finished song plays the next one in the same player; unplayable videos are skipped a few times at most', async ({ page }) => {
  await page.goto('/');
  await page.locator('#transport-play').click();
  await expect(page.locator('#player-status')).toContainText('ready');
  const ids = await page.evaluate(() => [...document.querySelectorAll('#track-list button')].map((b) => b.dataset.trackId));
  const videoOf = (id) => page.evaluate((trackId) => window.SEA_DATA.releases.find((r) => r.id === trackId).youtubeId, id);
  const event = (name, data) => page.evaluate(([n, d]) => window.__playerOptions.events[n]({ data: d }), [name, data]);

  await event('onStateChange', 1);
  await event('onStateChange', 0);
  await expect(page.locator('#sea')).toHaveAttribute('data-selected', ids[1]);
  expect(await page.evaluate(() => window.__transport.loads)).toEqual([await videoOf(ids[1])]);
  await expect(page.locator('#youtube-player')).toHaveCount(1);
  await expect(page.locator('#d-youtube')).toHaveAttribute('href', new RegExp(await videoOf(ids[1])));

  // Embedding refused: skip ahead after a moment.
  await event('onError', 150);
  await expect(page.locator('#player-status')).toContainText('Skipping');
  await expect(page.locator('#sea')).toHaveAttribute('data-selected', ids[2]);
  await event('onStateChange', 1);

  // A blocked YouTube must not spin through the whole list.
  for (let i = 0; i < 5; i += 1) {
    await event('onError', 150);
    await expect(page.locator('#sea')).toHaveAttribute('data-selected', ids[3 + i]);
  }
  await event('onError', 150);
  await expect(page.locator('#player-status')).toContainText('playback stopped');
  await page.waitForTimeout(2000);
  await expect(page.locator('#sea')).toHaveAttribute('data-selected', ids[7]);
});
