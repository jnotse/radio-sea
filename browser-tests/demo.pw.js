import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// UI tests do not depend on YouTube being online or playable in CI. Actual
// embeds get a separate live smoke test. The fake API exercises player errors.
test.beforeEach(async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({
    contentType: 'text/javascript', body: `window.__transport={play:0,pause:0,stop:0,volume:75,time:42,duration:240,seeks:[]};
    window.YT={Player:function(frame,opts){
      this.destroy=()=>frame.remove(); this.playVideo=()=>{window.__transport.play++};
      this.pauseVideo=()=>{window.__transport.pause++;opts.events.onStateChange({data:2})};
      this.stopVideo=()=>{window.__transport.stop++;window.__transport.time=0};
      this.setVolume=(v)=>{window.__transport.volume=v};
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

test.describe('touch screens', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  async function touchMap(page) {
    const canvas = page.locator('#sea');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const send = (type, points) => cdp.send('Input.dispatchTouchEvent',
      { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const camera = async () => ({ zoom: Number(await canvas.getAttribute('data-zoom')),
      x: Number(await canvas.getAttribute('data-camera-x')), y: Number(await canvas.getAttribute('data-camera-y')) });
    return { canvas, send, camera, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
  }

  test('two-finger pinch zooms around the fingers without selecting a tile', async ({ page }) => {
    await page.goto('/');
    const { canvas, send, camera, cx, cy } = await touchMap(page);
    const before = await camera();
    const selected = await canvas.getAttribute('data-selected');
    await send('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
    for (let i = 1; i <= 8; i += 1) await send('touchMove', [[cx - 30 - i * 10, cy], [cx + 30 + i * 10, cy]]);
    await send('touchEnd', []);
    const after = await camera();
    // Fingers moved from 60px to 220px apart around the canvas centre.
    expect(after.zoom / before.zoom).toBeGreaterThan(3);
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.5);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.5);
    await expect(canvas).toHaveAttribute('data-selected', selected);
    await expect(page.locator('#youtube-player')).toHaveCount(0);

    await send('touchStart', [[cx - 80, cy], [cx + 80, cy]]);
    for (let i = 1; i <= 6; i += 1) await send('touchMove', [[cx - 80 + i * 10, cy], [cx + 80 - i * 10, cy]]);
    await send('touchEnd', []);
    expect((await camera()).zoom).toBeLessThan(after.zoom);
  });

  test('one finger pans the map and a tap plays a tile', async ({ page }) => {
    await page.goto('/');
    const { canvas, send, camera, cx, cy } = await touchMap(page);
    const before = await camera();
    await send('touchStart', [[cx, cy]]);
    for (let i = 1; i <= 8; i += 1) await send('touchMove', [[cx + i * 10, cy]]);
    await send('touchEnd', []);
    const after = await camera();
    expect(after.zoom).toBe(before.zoom);
    expect(after.x).toBeCloseTo(before.x - 80 / before.zoom, 1);

    await page.locator('#btn-home').click();
    await canvas.scrollIntoViewIfNeeded();
    const id = await page.evaluate(() => window.SEA_DATA.releases.find((r) => r.id !== document.querySelector('#sea').dataset.selected).id);
    const p = await screenPoint(page, id);
    // A fingertip lands near, not exactly on, a 6px square.
    await send('touchStart', [[p.x + 9, p.y]]);
    await send('touchEnd', []);
    await expect(canvas).toHaveAttribute('data-selected', id);
    await expectPlaying(page, id);
  });
});

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
