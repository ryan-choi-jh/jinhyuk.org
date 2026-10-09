// The studio's canvas interaction layer.
//
// The page in the middle is rendered by the site's own renderer, so what you
// are dragging things around on is the published layout. This attaches to the
// .cv-item elements in that markup and keeps two things in step: the DOM, so
// you see the change immediately, and a model, which is what gets committed.
//
// Positions are stored against a 1344px reference width (CANVAS_W), the same
// space the renderer converts to percentages. The stage scales the whole page
// to fit the window, so every pointer delta is divided by that scale before
// it becomes a coordinate.

const CANVAS_W = 1344;
const PAGE_W = 1440;

type Item = {
  kind: 'image' | 'video' | 'embed' | 'shape';
  src?: string;
  alt?: string;
  caption?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  z?: number;
  shape?: 'line' | 'rect' | 'ellipse' | 'squiggle';
  color?: string;
  fill?: string;
  strokeWidth?: number;
  radius?: number;
};

type Block = {
  index: number;
  type: string;
  tag: string | null;
  label: string;
  canvas: { height: number; items: Item[] } | null;
};

type State = { slug: string; branch: string; blocks: Block[] };

/** The site's own tokens, plus a few, so a colour picked here belongs here. */
const SWATCHES = [
  '#111111', '#6b6b6b', '#ff5722', '#f5a623',
  '#c0392b', '#d35400', '#2e7d52', '#2563a8', '#6b4ea8', '#ffffff',
];

let state: State;
let scale = 1;
let dirty = false;
/** Which canvas block, and which item inside it, is selected. */
let sel: { block: number; item: number } | null = null;

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T | null;

export function initStudio(): void {
  const raw = document.getElementById('s-state')?.textContent;
  if (!raw) return;
  state = JSON.parse(raw);

  layoutStage();
  window.addEventListener('resize', layoutStage);

  indexCanvases();
  buildRail();
  wireStage();
  wireSave();
}

/* ------------------------------------------------------------------ stage */

/** Fit the 1440px page into whatever room the stage has. */
function layoutStage(): void {
  const stage = $('#s-stage');
  const page = $('#s-page');
  if (!stage || !page) return;
  const room = stage.clientWidth - 48;
  scale = Math.min(1, room / PAGE_W);
  (page as HTMLElement).style.transform = `scale(${scale})`;
  // The scaled element still reserves its unscaled height, so pull the stage's
  // scroll height back in line with what is actually drawn.
  (page as HTMLElement).style.marginBottom = `${-(1 - scale) * page.scrollHeight}px`;
}

/** Tie each rendered .canvas element to the block it came from. */
function indexCanvases(): void {
  const rendered = Array.from(document.querySelectorAll<HTMLElement>('#s-body .canvas'));
  const canvasBlocks = state.blocks.filter((b) => b.canvas);
  rendered.forEach((el, i) => {
    const block = canvasBlocks[i];
    if (!block) return;
    el.dataset.block = String(block.index);
    Array.from(el.querySelectorAll<HTMLElement>('.cv-item')).forEach((itemEl, j) => {
      itemEl.dataset.block = String(block.index);
      itemEl.dataset.item = String(j);
    });
  });
}

function blockByIndex(i: number): Block | undefined {
  return state.blocks.find((b) => b.index === i);
}

function selectedItem(): Item | null {
  if (!sel) return null;
  return blockByIndex(sel.block)?.canvas?.items[sel.item] ?? null;
}

function itemEl(block: number, item: number): HTMLElement | null {
  return document.querySelector(`.cv-item[data-block="${block}"][data-item="${item}"]`);
}

/* ------------------------------------------------------------------- rail */

function buildRail(): void {
  const ul = $('#s-blocks');
  if (!ul) return;
  ul.innerHTML = '';
  for (const b of state.blocks) {
    const li = document.createElement('li');
    if (b.canvas) li.className = 'is-canvas';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label || b.type;
    btn.addEventListener('click', () => {
      const el = b.canvas
        ? document.querySelector(`.canvas[data-block="${b.index}"]`)
        : null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const first = b.canvas?.items.length ? 0 : null;
        if (first !== null) select(b.index, first);
      }
    });
    li.appendChild(btn);

    // Adding a canvas changes every later block's index, so rather than try to
    // keep the client's model in step, the server re-parses and the page
    // reloads. It is one round trip for something you do rarely.
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 's-addhere';
    add.title = 'Add a canvas below this block';
    add.textContent = '+';
    add.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (dirty && !confirm('You have unsaved changes. Add a canvas and lose them?')) return;
      setStatus('Adding canvas…');
      const res = await fetch('/studio/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: state.slug,
          branch: state.branch,
          edits: [
            {
              op: 'insertAfter',
              index: b.index,
              height: 280,
              items: [
                {
                  kind: 'shape',
                  shape: 'ellipse',
                  x: 760,
                  y: 20,
                  w: 300,
                  h: 220,
                  color: '#ff5722',
                  strokeWidth: 2,
                },
              ],
            },
          ],
        }),
      });
      const out = await res.json();
      if (!res.ok) {
        setStatus(out.error ?? 'Could not add it', 'bad');
        return;
      }
      dirty = false;
      location.reload();
    });
    li.appendChild(add);
    ul.appendChild(li);
  }
  markRail();
}

function markRail(): void {
  const ul = $('#s-blocks');
  if (!ul) return;
  Array.from(ul.children).forEach((li, i) => {
    li.classList.toggle('is-active', !!sel && state.blocks[i]?.index === sel.block);
  });
}

/* --------------------------------------------------------------- dragging */

function wireStage(): void {
  const body = $('#s-body');
  if (!body) return;

  body.addEventListener('pointerdown', (ev) => {
    const target = ev.target as HTMLElement;

    if (target.classList.contains('s-handle')) return; // handled below
    const el = target.closest<HTMLElement>('.cv-item');
    if (!el) {
      select(null);
      return;
    }
    ev.preventDefault();

    const block = Number(el.dataset.block);
    const item = Number(el.dataset.item);
    select(block, item);
    startDrag(ev as PointerEvent, el, 'move');
  });

  // Clicking the page but not an item clears the selection.
  body.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('.cv-item, .s-handle')) select(null);
  });
}

type Mode = 'move' | 'size' | 'rotate';

function startDrag(ev: PointerEvent, el: HTMLElement, mode: Mode): void {
  const it = selectedItem();
  if (!it || !sel) return;

  const startX = ev.clientX;
  const startY = ev.clientY;
  const from = { x: it.x, y: it.y, w: it.w, h: it.h, rotate: it.rotate ?? 0 };

  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const startAngle = Math.atan2(ev.clientY - cy, ev.clientX - cx);

  el.classList.add('is-dragging');
  (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);

  const onMove = (e: PointerEvent) => {
    // Pointer space is scaled; coordinate space is not.
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;

    if (mode === 'move') {
      it.x = Math.round(from.x + dx);
      it.y = Math.round(from.y + dy);
    } else if (mode === 'size') {
      const ratio = from.h / Math.max(1, from.w);
      it.w = Math.max(24, Math.round(from.w + dx));
      // Shift keeps the aspect ratio, which is what you want for a photo.
      it.h = e.shiftKey ? Math.round(it.w * ratio) : Math.max(24, Math.round(from.h + dy));
    } else {
      const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
      let deg = from.rotate + ((angle - startAngle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      it.rotate = Math.round(deg);
    }

    applyItem(sel!.block, sel!.item);
    syncInspector();
    touch();
  };

  const onUp = () => {
    el.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** Push one item's numbers back onto its element. */
function applyItem(block: number, item: number): void {
  const b = blockByIndex(block);
  const it = b?.canvas?.items[item];
  const el = itemEl(block, item);
  if (!b || !it || !el) return;

  el.style.left = `${(it.x / CANVAS_W) * 100}%`;
  el.style.top = `${it.y}px`;
  el.style.width = `${(it.w / CANVAS_W) * 100}%`;
  el.style.transform = it.rotate ? `rotate(${it.rotate}deg)` : '';
  if (it.z) el.style.zIndex = String(it.z);

  // A shape is drawn from its own numbers, so it has to be redrawn.
  if (it.kind === 'shape') {
    const svg = el.querySelector('svg');
    if (svg) svg.outerHTML = shapeSvg(it);
  }

  // Keep the block tall enough for whatever is now inside it.
  const canvasEl = document.querySelector<HTMLElement>(`.canvas[data-block="${block}"]`);
  if (canvasEl && b.canvas) {
    const needed =
      b.canvas.items.reduce((h, i) => Math.max(h, (i.y ?? 0) + (i.h ?? 0)), 0) + 24;
    b.canvas.height = Math.max(120, Math.round(needed));
    canvasEl.style.height = `${b.canvas.height}px`;
  }
}

function shapeSvg(it: Item): string {
  const w = it.w, h = it.h;
  const stroke = it.color || 'currentColor';
  const sw = it.strokeWidth ?? 2;
  const fill = it.fill || 'none';
  let inner: string;
  if (it.shape === 'rect') {
    inner = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" rx="${it.radius ?? 0}"/>`;
  } else if (it.shape === 'ellipse') {
    inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  } else if (it.shape === 'squiggle') {
    const d = `M 0 ${h * 0.7} C ${w * 0.18} ${h * 0.1}, ${w * 0.32} ${h * 0.95}, ${w * 0.5} ${h * 0.45} C ${w * 0.68} ${h * -0.05}, ${w * 0.82} ${h * 0.9}, ${w} ${h * 0.3}`;
    inner = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
  } else {
    inner = `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${inner}</svg>`;
}

/* -------------------------------------------------------------- selection */

function select(block: number | null, item?: number): void {
  document.querySelectorAll('.cv-item.is-selected').forEach((e) => e.classList.remove('is-selected'));
  document.querySelectorAll('.s-handle').forEach((e) => e.remove());

  if (block === null || item === undefined) {
    sel = null;
    renderInspector();
    markRail();
    return;
  }

  sel = { block, item };
  const el = itemEl(block, item);
  if (el) {
    el.classList.add('is-selected');
    addHandle(el, 'size');
    addHandle(el, 'rotate');
  }
  renderInspector();
  markRail();
}

function addHandle(el: HTMLElement, mode: Exclude<Mode, 'move'>): void {
  const h = document.createElement('div');
  h.className = `s-handle s-handle--${mode === 'size' ? 'size' : 'rot'}`;
  h.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startDrag(ev as PointerEvent, el, mode);
  });
  el.appendChild(h);
}

/* -------------------------------------------------------------- inspector */

function renderInspector(): void {
  const host = $('#s-inspector');
  if (!host) return;
  const it = selectedItem();

  if (!it || !sel) {
    host.innerHTML = '<p class="s-hint">Select something on the page.</p>';
    renderAdders(host);
    return;
  }

  const isShape = it.kind === 'shape';
  host.innerHTML = `
    <div class="s-row">
      ${num('x', 'X', it.x)}
      ${num('y', 'Y', it.y)}
    </div>
    <div class="s-row">
      ${num('w', 'Width', it.w)}
      ${num('h', 'Height', it.h)}
    </div>
    <div class="s-row">
      ${num('rotate', 'Rotation', it.rotate ?? 0)}
      ${num('z', 'Stacking', it.z ?? 0)}
    </div>
    ${
      isShape
        ? `<div class="s-field"><label>Shape</label>
             <select data-k="shape">
               ${['line', 'rect', 'ellipse', 'squiggle']
                 .map((s) => `<option value="${s}" ${it.shape === s ? 'selected' : ''}>${s}</option>`)
                 .join('')}
             </select></div>
           ${num('strokeWidth', 'Stroke width', it.strokeWidth ?? 2)}
           ${colorField('color', 'Line colour', it.color ?? '#111111')}
           ${colorField('fill', 'Fill', it.fill ?? '#ffffff')}`
        : `<div class="s-field"><label>Alt text</label>
             <input type="text" data-k="alt" value="${esc(it.alt ?? '')}"></div>`
    }
    <div class="s-field"><label>Caption</label>
      <input type="text" data-k="caption" value="${esc(it.caption ?? '')}"></div>
    <div class="s-sep"></div>
    <button class="s-btn s-btn--danger" type="button" data-act="delete">Delete item</button>
  `;

  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.k as keyof Item;
      const value =
        input.type === 'number' ? Number(input.value) : (input.value as unknown);
      (it as any)[key] = value;
      applyItem(sel!.block, sel!.item);
      touch();
    });
  });

  host.querySelectorAll<HTMLButtonElement>('.s-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const key = sw.dataset.for as keyof Item;
      (it as any)[key] = sw.dataset.color;
      renderInspector();
      applyItem(sel!.block, sel!.item);
      touch();
    });
  });

  host.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
    const b = blockByIndex(sel!.block);
    if (!b?.canvas) return;
    b.canvas.items.splice(sel!.item, 1);
    itemEl(sel!.block, sel!.item)?.remove();
    // Re-number the remaining elements so indices keep matching the model.
    const canvasEl = document.querySelector(`.canvas[data-block="${sel!.block}"]`);
    Array.from(canvasEl?.querySelectorAll<HTMLElement>('.cv-item') ?? []).forEach((e, j) => {
      e.dataset.item = String(j);
    });
    select(null);
    touch();
  });

  renderAdders(host);
}

function renderAdders(host: HTMLElement): void {
  const canvasBlocks = state.blocks.filter((b) => b.canvas);
  if (canvasBlocks.length === 0) return;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="s-sep"></div>
    <div class="s-rail-head" style="padding-left:0">Add to canvas</div>
    <div class="s-field">
      <select id="s-target">
        ${canvasBlocks
          .map(
            (b) =>
              `<option value="${b.index}" ${sel?.block === b.index ? 'selected' : ''}>${b.label}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="s-add" style="padding:0">
      <button class="s-btn" data-add="line">Line</button>
      <button class="s-btn" data-add="rect">Box</button>
      <button class="s-btn" data-add="ellipse">Ellipse</button>
      <button class="s-btn" data-add="squiggle">Squiggle</button>
      <button class="s-btn" data-add="image">Image…</button>
    </div>
    <input type="file" id="s-file" accept="image/*,video/mp4,video/webm" hidden>
  `;
  host.appendChild(wrap);

  wrap.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.add!;
      if (kind === 'image') {
        ($('#s-file') as HTMLInputElement).click();
        return;
      }
      addItem({
        kind: 'shape',
        shape: kind as Item['shape'],
        x: 120,
        y: 40,
        w: kind === 'line' ? 320 : 240,
        h: kind === 'line' ? 24 : 180,
        color: '#ff5722',
        strokeWidth: 2,
      });
    });
  });

  $('#s-file')?.addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setStatus('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('slug', state.slug);
    fd.append('branch', state.branch);
    const res = await fetch('/studio/api/upload', { method: 'POST', body: fd });
    const out = await res.json();
    input.value = '';
    if (!res.ok) {
      setStatus(out.error ?? 'Upload failed', 'bad');
      return;
    }
    setStatus('Uploaded', 'good');
    addItem({ kind: 'image', src: out.src, x: 120, y: 40, w: 320, h: 240, alt: '' });
  });
}

function addItem(item: Item): void {
  const target = Number(($('#s-target') as HTMLSelectElement | null)?.value ?? NaN);
  const b = blockByIndex(target);
  if (!b?.canvas) return;

  b.canvas.items.push(item);
  const i = b.canvas.items.length - 1;

  const el = document.createElement('div');
  el.className = `cv-item cv-item--${item.kind}`;
  el.dataset.block = String(b.index);
  el.dataset.item = String(i);
  el.innerHTML =
    item.kind === 'shape'
      ? shapeSvg(item)
      : `<img src="${esc(item.src ?? '')}" alt="">`;
  document.querySelector(`.canvas[data-block="${b.index}"]`)?.appendChild(el);

  applyItem(b.index, i);
  select(b.index, i);
  touch();
}

function num(key: string, label: string, value: number): string {
  return `<div class="s-field"><label>${label}</label>
    <input type="number" data-k="${key}" value="${Number.isFinite(value) ? value : 0}"></div>`;
}

function colorField(key: string, label: string, value: string): string {
  return `<div class="s-field"><label>${label}</label>
    <div class="s-colorrow">
      <input type="color" data-k="${key}" value="${esc(value)}">
      <input type="text" data-k="${key}" value="${esc(value)}">
    </div>
    <div class="s-swatches">
      ${SWATCHES.map(
        (c) =>
          `<button class="s-swatch" type="button" data-for="${key}" data-color="${c}" style="background:${c}" title="${c}"></button>`
      ).join('')}
    </div></div>`;
}

function syncInspector(): void {
  const it = selectedItem();
  if (!it) return;
  document.querySelectorAll<HTMLInputElement>('#s-inspector input[type="number"]').forEach((i) => {
    const k = i.dataset.k as keyof Item;
    const v = (it as any)[k];
    if (typeof v === 'number') i.value = String(v);
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ------------------------------------------------------------------- save */

function touch(): void {
  dirty = true;
  const btn = $('#s-save') as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
  setStatus('Unsaved changes');
}

function setStatus(text: string, tone?: 'bad' | 'good'): void {
  const el = $('#s-status');
  if (!el) return;
  el.textContent = text;
  if (tone) el.setAttribute('data-tone', tone);
  else el.removeAttribute('data-tone');
}

function wireSave(): void {
  const btn = $('#s-save') as HTMLButtonElement | null;
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus('Saving…');
    const edits = state.blocks
      .filter((b) => b.canvas)
      .map((b) => ({
        op: 'update' as const,
        index: b.index,
        height: b.canvas!.height,
        items: b.canvas!.items,
      }));

    try {
      const res = await fetch('/studio/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: state.slug, branch: state.branch, edits }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? `Save failed (${res.status})`);
      dirty = false;
      setStatus(out.unchanged ? 'No changes' : 'Saved', 'good');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), 'bad');
      btn.disabled = false;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
