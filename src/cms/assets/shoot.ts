/**
 * src/cms/assets/shoot.ts
 *
 * WS-6's evidence. Drives headless Chrome over the DevTools protocol and
 * screenshots the catalogue (and the picker harness, if it has been built),
 * section by section, so the drawings can be looked at rather than reasoned
 * about.
 *
 *   node src/cms/assets/catalogue.ts            # build the page
 *   node src/cms/assets/shoot.ts                # shoot it
 *
 * Output: src/cms/assets/.build/shots/*.png  (build artifacts; safe to delete)
 * Chrome: set CHROME_PATH to override the macOS default.
 *
 * No puppeteer, no playwright, no install: Node's global WebSocket plus the
 * /json endpoints is all the protocol needs.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const outDir = here('./.build/shots/');

type Shot = {
  name: string;
  file: string;
  /** CSS selector to clip to. Omitted means the whole page. */
  selector?: string;
  width?: number;
  scale?: number;
  /** JS run in the page before the shot, for driving the picker. Awaited. */
  prepare?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Minimal CDP client                                                         */
/* -------------------------------------------------------------------------- */

type Client = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  once(method: string): Promise<void>;
  close(): void;
};

async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const waiters = new Map<string, (() => void)[]>();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
    const id = message['id'];
    if (typeof id === 'number') {
      pending.get(id)?.(message);
      pending.delete(id);
      return;
    }
    const method = String(message['method'] ?? '');
    const list = waiters.get(method);
    if (list !== undefined) {
      waiters.delete(method);
      for (const resolve of list) resolve();
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = (nextId += 1);
        pending.set(id, (message) => {
          const error = message['error'] as { message?: string } | undefined;
          if (error !== undefined) reject(new Error(`${method}: ${error.message ?? 'failed'}`));
          else resolve((message['result'] ?? {}) as Record<string, unknown>);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        waiters.set(method, [...(waiters.get(method) ?? []), resolve]);
      });
    },
    close() {
      socket.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(CHROME)) {
    console.error(`no Chrome at ${CHROME}; set CHROME_PATH`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const catalogue = here('./catalogue.html');
  if (!existsSync(catalogue)) {
    console.error('no catalogue.html; run: node src/cms/assets/catalogue.ts');
    process.exit(1);
  }
  const catalogueUrl = `file://${catalogue}`;
  const harness = here('./.build/harness.html');
  const harnessUrl = existsSync(harness) ? `file://${harness}` : null;

  const port = 9411 + (process.pid % 97);
  const profile = mkdtempSync(join(tmpdir(), 'ws6-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let browserWs = '';
  for (let attempt = 0; attempt < 60 && browserWs === ''; attempt += 1) {
    await sleep(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = (await response.json()) as { webSocketDebuggerUrl?: string };
      browserWs = info.webSocketDebuggerUrl ?? '';
    } catch {
      /* not up yet */
    }
  }
  if (browserWs === '') {
    chrome.kill();
    console.error('Chrome never opened a debugging port');
    process.exit(1);
  }

  const browser = await connect(browserWs);

  const shoot = async (url: string, shot: Shot): Promise<void> => {
    const created = await browser.send('Target.createTarget', { url: 'about:blank' });
    const targetId = String(created['targetId']);
    const page = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const width = shot.width ?? 1500;
    const scale = shot.scale ?? 1;
    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const loaded = page.once('Page.loadEventFired');
      await page.send('Page.navigate', { url });
      await loaded;
      await sleep(350);
      if (shot.prepare !== undefined) {
        const ran = (await page.send('Runtime.evaluate', {
          expression: `(async () => { ${shot.prepare} })()`,
          awaitPromise: true,
          returnByValue: true,
        })) as { exceptionDetails?: { text?: string } };
        if (ran.exceptionDetails !== undefined) {
          throw new Error(`prepare failed: ${ran.exceptionDetails.text ?? 'unknown'}`);
        }
        await sleep(250);
      }

      let clip: Record<string, number> | undefined;
      if (shot.selector !== undefined) {
        const probe = (await page.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(
            shot.selector,
          )}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
          returnByValue: true,
        })) as { result?: { value?: Record<string, number> | null } };
        const rect = probe.result?.value ?? null;
        if (rect === null) throw new Error(`selector not found: ${shot.selector}`);
        clip = { ...rect, scale };
      }

      const captured = (await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        ...(clip !== undefined ? { clip } : {}),
      })) as { data?: string };
      const data = String(captured['data'] ?? '');
      writeFileSync(join(outDir, shot.file), Buffer.from(data, 'base64'));
      console.log(`  ${shot.file}  ${shot.name}`);
    } finally {
      page.close();
      await browser.send('Target.closeTarget', { targetId });
    }
  };

  const catalogueShots: Shot[] = [
    { name: 'whole catalogue', file: '01-catalogue-full.png' },
    { name: 'squiggle hero', file: '02-hero.png', selector: '#hero', scale: 2 },
    { name: 'every kind, four seeds', file: '03-kinds.png', selector: '#kinds', scale: 1.5 },
    { name: 'size sweep', file: '04-sizes.png', selector: '#sizes', scale: 1 },
    { name: 'stroke widths', file: '05-strokes.png', selector: '#strokes', scale: 1 },
    { name: 'colour and fill', file: '06-colour.png', selector: '#colour', scale: 1.25 },
    { name: 'degenerate boxes', file: '07-extremes.png', selector: '#extremes', scale: 1.5 },
    { name: 'fixture parity', file: '08-fixtures.png', selector: '#fixtures', scale: 1.5 },
    { name: 'container scaling', file: '09-scaling.png', selector: '#scaling', scale: 1.25 },
    { name: 'dark ground', file: '10-dark.png', selector: '#dark', scale: 1.25 },
  ];

  console.log('catalogue:');
  for (const shot of catalogueShots) await shoot(catalogueUrl, shot);

  if (harnessUrl !== null) {
    console.log('picker harness:');
    const click = `
      const tick = () => new Promise((r) => setTimeout(r, 90));
      const byText = (text) => [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === text);
      const kind = (k) => document.querySelector('button[title="' + k + '"]');
      const insert = () => byText('Insert').click();
    `;
    for (const shot of [
      { name: 'picker, default', file: '20-picker.png', selector: '#picker-shell', scale: 2 },
      {
        name: 'picker, rect with a fill',
        file: '22-picker-rect.png',
        selector: '#picker-shell',
        scale: 2,
        prepare: `${click}
          kind('rect').click(); await tick();
          byText('tint').click(); await tick();
          document.querySelector('input[aria-label="Corner radius"]')
            .dispatchEvent(new Event('input', { bubbles: true }));
        `,
      },
      {
        name: 'harness after five inserts',
        file: '21-harness-full.png',
        prepare: `${click}
          for (const k of ['squiggle', 'arrow', 'line', 'ellipse', 'rect']) {
            kind(k).click(); await tick();
            if (k === 'ellipse' || k === 'rect') { byText('tint').click(); await tick(); }
            insert(); await tick();
          }
        `,
      },
    ] satisfies Shot[]) {
      await shoot(harnessUrl, shot);
    }
  }

  browser.close();
  chrome.kill();
  console.log(`\nshots in ${outDir}`);
}

await main();
