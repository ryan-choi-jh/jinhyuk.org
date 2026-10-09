// Reading and writing .mdoc files for the studio.
//
// The guiding rule here: the editor never rewrites the whole file. Markdoc
// reports an exact line range for every top-level node, so a change to a
// canvas is spliced into those lines and every other byte of the document is
// left exactly as it was. Prose cannot be reflowed, reordered or mangled by a
// serialiser bug, because prose is never serialised.

import Markdoc from '@markdoc/markdoc';

export type CanvasItem = {
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

export type Block = {
  /** Index among the document's top-level nodes. */
  index: number;
  type: string;
  tag: string | null;
  /** Zero-based index of the node's first body line. */
  start: number;
  /** Zero-based index one past its last line, so [start, end). */
  end: number;
  /** The node's own source text. */
  source: string;
  /** Present for Canvas blocks. */
  canvas?: { height: number; items: CanvasItem[] };
  /** A short description for the block list in the UI. */
  label: string;
};

export type ParsedDoc = {
  /** Everything up to and including the closing frontmatter fence. */
  frontmatter: string;
  /** The body, verbatim. */
  body: string;
  bodyLines: string[];
  blocks: Block[];
};

const FENCE = /^---\s*$/m;

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  // A file always starts with ---\n ... \n---\n. Find the second fence and cut
  // there, keeping the fence itself with the frontmatter.
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  const rest = raw.slice(3);
  const m = rest.match(FENCE);
  if (!m || m.index === undefined) return { frontmatter: '', body: raw };
  const end = 3 + m.index + m[0].length;
  return { frontmatter: raw.slice(0, end), body: raw.slice(end).replace(/^\n/, '') };
}

function firstWords(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function parseDoc(raw: string): ParsedDoc {
  const { frontmatter, body } = splitFrontmatter(raw);
  const bodyLines = body.split('\n');
  const ast = Markdoc.parse(body);

  const blocks: Block[] = [];
  let index = 0;
  for (const node of ast.children as any[]) {
    const loc = node.location;
    if (!loc) continue;
    // Markdoc reports these zero-based, and end is already exclusive. Reading
    // them as 1-based silently shifts every block by a line, which on save
    // would splice a line of prose away with each canvas edit.
    const start = loc.start.line;
    const end = loc.end.line;
    const source = bodyLines.slice(start, end).join('\n');

    const block: Block = {
      index,
      type: node.type,
      tag: node.tag ?? null,
      start,
      end,
      source,
      label: '',
    };

    if (node.type === 'tag' && node.tag === 'Canvas') {
      const attrs = node.attributes ?? {};
      block.canvas = {
        height: Number(attrs.height ?? 400),
        items: (attrs.items ?? []) as CanvasItem[],
      };
      const n = block.canvas.items.length;
      block.label = `Canvas · ${n} ${n === 1 ? 'item' : 'items'}`;
    } else if (node.type === 'tag') {
      block.label = `${node.tag}`;
    } else if (node.type === 'heading') {
      block.label = `# ${firstWords(source.replace(/^#+\s*/, ''))}`;
    } else {
      block.label = firstWords(source);
    }

    blocks.push(block);
    index += 1;
  }

  return { frontmatter, body, bodyLines, blocks };
}

/** The canonical text for a Canvas tag. Written over several lines so a diff
 *  of a position change stays readable in the repo's history. */
export function serialiseCanvas(height: number, items: CanvasItem[]): string {
  const rows = items.map((it) => `    ${JSON.stringify(it)}`).join(',\n');
  return `{% Canvas\n  height=${Math.round(height)}\n  items=[\n${rows}\n  ] /%}`;
}

export type CanvasEdit =
  | { op: 'update'; index: number; height: number; items: CanvasItem[] }
  | { op: 'insertAfter'; index: number; height: number; items: CanvasItem[] }
  | { op: 'delete'; index: number };

/**
 * Apply edits to a document and return the new file text.
 *
 * Edits are applied from the bottom of the document upwards so that each
 * splice cannot shift the line numbers of the ones still to be applied.
 */
export function applyEdits(raw: string, edits: CanvasEdit[]): string {
  const doc = parseDoc(raw);
  const lines = [...doc.bodyLines];

  const byIndex = new Map(doc.blocks.map((b) => [b.index, b]));
  const ordered = [...edits].sort((a, b) => {
    const ba = byIndex.get(a.index);
    const bb = byIndex.get(b.index);
    return (bb?.start ?? 0) - (ba?.start ?? 0);
  });

  for (const edit of ordered) {
    const block = byIndex.get(edit.index);
    if (!block) continue;

    if (edit.op === 'update') {
      if (block.tag !== 'Canvas') continue;
      const text = serialiseCanvas(edit.height, edit.items);
      lines.splice(block.start, block.end - block.start, ...text.split('\n'));
    } else if (edit.op === 'delete') {
      if (block.tag !== 'Canvas') continue;
      // Take the blank line after it too, so deleting does not leave a gap.
      let count = block.end - block.start;
      if ((lines[block.end] ?? '').trim() === '') count += 1;
      lines.splice(block.start, count);
    } else if (edit.op === 'insertAfter') {
      const text = serialiseCanvas(edit.height, edit.items);
      lines.splice(block.end, 0, '', ...text.split('\n'));
    }
  }

  const body = lines.join('\n');
  return `${doc.frontmatter}\n${body.startsWith('\n') ? body.slice(1) : body}`;
}
