/**
 * src/cms/schema.ts
 *
 * WS-0 CONTRACTS. The single source of truth for the jinhyuk.org CMS document
 * model. Every other workstream imports its types from here and nothing else.
 *
 * Owned by WS-0. If something in this file is wrong, say so in your report.
 * Do not edit it.
 *
 * Shape follows docs/cms-rebuild.md sections 3.1 (Document), 3.2 (Prose) and
 * 3.3 (Canvas). docs/cms-contracts.md is the prose companion to this file and
 * carries the API table, the renderer signature and the asset generator
 * signature.
 *
 * Phase 2 (docs/cms-sections.md) added the other four surfaces of the site:
 * the section list, `Doc.meta.section` and `Doc.meta.buttons`, and the two
 * record collections, Film and Album, at the foot of this file. Everything
 * phase 1 shipped is unchanged. `src/cms/sections.ts` is the registry that
 * maps a section to its files, its editor and its fields.
 *
 * Two rules that are easy to miss:
 *
 *  1. Every object schema is `.strict()`. An unknown key is a validation
 *     error, not something silently dropped. Keep editor-only state (selection,
 *     hover, drag deltas) out of the document.
 *  2. All geometry is in reference pixels against REFERENCE_WIDTH (1344). The
 *     renderer converts x and w to percentages; y and h stay in px.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Document format version. Bumping this is a migration, not a patch. */
export const DOC_VERSION = 1;

/**
 * Canvas geometry is authored against this content width, in CSS px.
 * Nobody hardcodes 1344. docs/cms-rebuild.md section 3.3 and rule 6.
 */
export const REFERENCE_WIDTH = 1344;

/**
 * The page the content column sits on, and the margin either side of it.
 * `--page` and `--gutter` in src/styles/global.css, which is where the site
 * gets them: `.wrap` and `.site-nav` are both `max-width: 1440px` with
 * `padding: 0 48px`, so a wide window shows a 1344px column with 48px of paper
 * on each side.
 *
 * REFERENCE_WIDTH IS NOT AN INDEPENDENT NUMBER: it is what is left of the page
 * once both gutters are taken off, which is why canvas geometry authored
 * against 1344 lands exactly on the published column. The assertion below says
 * so out loud, because the three constants drifting apart would misplace every
 * canvas item on the site and nothing else would notice.
 */
export const PAGE_WIDTH = 1440;
export const PAGE_GUTTER = 48;

if (PAGE_WIDTH - PAGE_GUTTER * 2 !== REFERENCE_WIDTH) {
  throw new Error(
    `the page constants disagree: ${PAGE_WIDTH} - 2x${PAGE_GUTTER} is ` +
      `${PAGE_WIDTH - PAGE_GUTTER * 2}, but REFERENCE_WIDTH is ${REFERENCE_WIDTH}`,
  );
}

/**
 * Below this viewport width the renderer drops canvas positioning entirely
 * (docs/cms-rebuild.md section 3.4). Nobody hardcodes 900. Rule 6.
 */
export const MOBILE_BREAKPOINT = 900;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Site-absolute path ("/media/slug/file.png") or an absolute http(s) URL. */
const SRC_RE = /^(?:\/\S*|https?:\/\/\S+)$/;

/**
 * Stable identifier. Generated once, never reused (section 3.1). Safe to use
 * directly as a DOM id suffix, which is why whitespace and slashes are out.
 */
export const IdSchema = z
  .string()
  .regex(ID_RE, 'id must be 1-64 characters from A-Z a-z 0-9 _ -');

/**
 * Why this is not a slug, in a sentence, or null if it is one.
 *
 * `SLUG_RE` answers yes or no, which is all a schema owes anyone. A person
 * typing into a field needs to know WHICH rule they broke, and the cost of
 * not telling them is concrete: the first version of the rename field
 * showed one fixed line — "lowercase letters, numbers and single hyphens,
 * not starting or ending with one" — for every rejection, including the
 * one it was actually making, which was a 64-character limit it had no
 * business imposing. The owner read a rule they had not broken and could
 * not press the button.
 *
 * SO THE RULE HERE IS THE SCHEMA'S RULE. Anything this function accepts,
 * `DocMetaSchema.shape.slug` accepts, and the reverse; `fixtures/verify.ts`
 * asserts that over a list of cases. A client stricter than the server is
 * how a legal value becomes unreachable.
 */
/**
 * How long a document slug may be.
 *
 * NOT a style rule. A slug is a file name, and `fillSlug` — the one function
 * that builds every content path — refuses anything outside
 * `[A-Za-z0-9_-]{1,64}`. So a longer slug cannot be stored at all: not
 * created, not renamed to, not saved.
 *
 * It lives here because it was enforced in three places and stated in none.
 * `fillSlug` threw a TypeError about a path pattern; `renameEntry` answered
 * `"…" is not a usable file name`; the field in the editor, which is where
 * someone actually types one, did not know about it and offered a 69
 * character slug that the server then refused. One rule, on the schema,
 * and the message that explains it is `slugProblem`.
 */
export const MAX_SLUG_LENGTH = 64;

/**
 * A title as a slug that will fit, cut at a word boundary.
 *
 * Cutting mid-word gives "…a-different-questi", which looks like damage.
 * Cutting back to the last hyphen gives "…a-different", which looks like a
 * decision. A single word longer than the limit has no boundary to cut at
 * and is simply trimmed.
 */
export function cappedSlug(text: string, limit = MAX_SLUG_LENGTH): string {
  const full = slugify(text);
  if (full.length <= limit) return full;
  const cut = full.slice(0, limit);
  const boundary = cut.lastIndexOf('-');
  const trimmed = boundary > 0 ? cut.slice(0, boundary) : cut;
  return trimmed.replace(/-+$/, '');
}

export function slugProblem(value: string): string | null {
  if (value === '') return 'A slug cannot be empty.';
  if (value.length > MAX_SLUG_LENGTH && SLUG_RE.test(value)) {
    // Reported before the shape, because a slug that is only too long is
    // otherwise told it is the wrong shape, which it is not.
    return `${value.length} characters is too long; the limit is ${MAX_SLUG_LENGTH}, because a slug is a file name. Try: ${cappedSlug(value)}`;
  }
  if (SLUG_RE.test(value)) return null;
  // A suggestion beats naming a rule, and it beats naming the offending
  // character too: the answer to "Caps And Spaces" is "caps-and-spaces",
  // not "slugs are lowercase" — which, followed literally, gives "caps and
  // spaces" and is still not a slug. The first version did exactly that.
  // `slugify` is declared further down this file and hoists. It is the one
  // the New-entry flow already uses to turn a title into a slug, so the
  // suggestion here is the same slug the CMS would have made itself.
  const suggestion = cappedSlug(value);
  if (suggestion !== '') return `Lowercase words joined by hyphens. Try: ${suggestion}`;
  return 'Lowercase letters and numbers, separated by single hyphens.';
}


/**
 * The slug this document should move to, or null to leave it alone.
 *
 * THE RULE, and every clause of it is load-bearing:
 *
 *  - `published` must be null. A page that has been live has a public
 *    address, and an address that changes by itself is a broken link
 *    somebody else is holding. Before the first publish there is no address
 *    to break and the move costs nothing.
 *  - `meta.slugFromTitle` must be true. Set at creation, cleared the moment
 *    the author renames by hand, absent on every page that predates the
 *    field.
 *  - the title must make a legal, non-empty slug. "???" makes nothing, and
 *    a page is not renamed to nothing.
 *  - it must differ from the slug it already has, or there is no move.
 *
 * Pure, and tested as such: everything about this feature that could go
 * wrong goes wrong HERE, so the browser only has to prove the wiring.
 */
export function slugToFollow(doc: Doc, published: Doc | null): string | null {
  if (published !== null) return null;
  if (doc.meta.slugFromTitle !== true) return null;
  // Capped, so a long title gives a slug that can actually be stored. An
  // uncapped one would be refused by the rename on every single save.
  const wanted = cappedSlug(doc.meta.title);
  if (wanted === '' || slugProblem(wanted) !== null) return null;
  if (wanted === doc.meta.slug) return null;
  return wanted;
}

export const SrcSchema = z
  .string()
  .regex(SRC_RE, 'src must be a site-absolute path like "/media/slug/file.png" or an http(s) URL');

export const HexColorSchema = z
  .string()
  .regex(HEX_RE, 'colour must be hex, e.g. #ff5722 or #ff5722cc');

/** `var(--accent, #ff5722)`, with the fallback optional. */
export const COLOR_TOKEN_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*(#[0-9a-fA-F]{3,8})\s*)?\)$/;

/**
 * What may appear in a `style="color:…"` attribute.
 *
 * TWO forms, not one: a canonical hex, and a reference to a site token. The
 * editor's palette stores the token form on purpose, so a colour follows the
 * theme instead of freezing the light-mode hex into the document.
 *
 * It lives here because both sides need the same answer and for a while they
 * did not: the editor stored `var(--muted, #6b6b6b)` and the published
 * renderer accepted hex only, so it dropped the mark and the colour appeared
 * in the CMS and nowhere else. Nothing had been coloured with a swatch yet,
 * which is the only reason it never showed.
 *
 * A stored colour ends up inside a style attribute, so the rule has to be
 * tight enough that nothing can close the declaration, open a block, or reach
 * the network. Both forms are fully anchored patterns; nothing else passes.
 */
export function isSafeStyleColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 64) return false;
  return HEX_RE.test(trimmed) || COLOR_TOKEN_RE.test(trimmed);
}

function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

export const DateSchema = z
  .string()
  .regex(DATE_RE, 'date must be YYYY-MM-DD')
  .refine(isRealCalendarDate, 'date must be a real calendar date');

/* -------------------------------------------------------------------------- */
/* Sections (phase 2, docs/cms-sections.md 2 and 4)                            */
/* -------------------------------------------------------------------------- */

/**
 * The five surfaces of the site, in the order the CMS's left-hand navigation
 * shows them. This file only names them; `src/cms/sections.ts` is the registry
 * that says what each one stores, where the files live and what fields a
 * record has. Nobody writes a section name as a bare string literal.
 */
export const SECTION_IDS = ['home', 'projects', 'essays', 'filmography', 'photography'] as const;

export const SectionIdSchema = z.enum(SECTION_IDS);

/**
 * What the body-size control allows, in CSS pixels.
 *
 * Here rather than in src/cms/styles/type-scale.ts because the schema is the
 * thing that refuses a bad value on the way in, and a bound the schema does
 * not know is a bound the server does not enforce. type-scale.ts re-exports
 * these so the slider and the validator cannot disagree.
 */
export const TYPE_SIZE_MIN = 12;
export const TYPE_SIZE_MAX = 24;
export type SectionId = z.infer<typeof SectionIdSchema>;

/**
 * The sections whose entries are `Doc`s. Filmography and photography hold
 * records, not documents, so `Doc.meta.section` can never name one of them —
 * `DocSchema` rejects it.
 */
export const DOCUMENT_SECTION_IDS = ['home', 'projects', 'essays'] as const;
export type DocumentSectionId = (typeof DOCUMENT_SECTION_IDS)[number];

/** The sections whose entries are records. */
export const RECORD_SECTION_IDS = ['filmography', 'photography'] as const;
export type RecordSectionId = (typeof RECORD_SECTION_IDS)[number];

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

export function isDocumentSectionId(value: string): value is DocumentSectionId {
  return (DOCUMENT_SECTION_IDS as readonly string[]).includes(value);
}

export function isRecordSectionId(value: string): value is RecordSectionId {
  return (RECORD_SECTION_IDS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Call-to-action buttons                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A link target a human typed into the editor. Deliberately wider than
 * `SrcSchema`: the essays that exist today link to `mailto:` addresses, and a
 * button may also point at another page on the site or at an anchor.
 */
const HREF_RE = /^(?:\/\S*|#\S+|https?:\/\/\S+|mailto:\S+)$/;

export const HrefSchema = z
  .string()
  .regex(
    HREF_RE,
    'href must be a site-absolute path, an http(s) URL, a mailto: address or a #fragment',
  );

/**
 * One end-of-document call to action. The shape is the one the live essays
 * already use in their frontmatter (`{ label, href }`), so the migration is a
 * copy rather than a translation.
 */
export const DocButtonSchema = z
  .object({
    label: z.string().min(1, 'button label must not be empty'),
    href: HrefSchema,
  })
  .strict();

export type DocButton = z.infer<typeof DocButtonSchema>;

/* -------------------------------------------------------------------------- */
/* 3.1 Document meta                                                           */
/* -------------------------------------------------------------------------- */

export const DocMetaSchema = z
  .object({
    title: z.string().min(1, 'title must not be empty'),
    slug: z
      .string()
      .regex(SLUG_RE, 'slug must be lowercase kebab-case')
      // A slug is a file name; `fillSlug` cannot build a path from a longer
      // one. Stated here so one schema is the authority instead of three
      // scattered guards.
      .max(MAX_SLUG_LENGTH, `a slug is at most ${MAX_SLUG_LENGTH} characters`),
    date: DateSchema,
    summary: z.string().optional(),
    /**
     * The "Visit" link.
     *
     * `http(s)` only, and NOT `z.string().url()`, which was the rule here
     * until it was measured. Zod's `.url()` is `new URL()` in a try/catch, and
     * `new URL('javascript:alert(1))')` succeeds, so the schema accepted a
     * scheme that becomes a live href on the published page. `mailto:` is out
     * as well: this field is rendered as "Visit <host and path>", which is
     * meaningless for an address.
     */
    url: z
      .string()
      // Case-insensitive on the scheme: `HTTPS://` is a legal URL, the old
      // rule accepted it, and narrowing a check should not start rejecting
      // things that were always fine.
      .regex(/^https?:\/\/\S+$/i, 'url must be an absolute http(s) URL')
      .optional(),
    /**
     * What that link is called, when "Visit" is not specific enough: a page
     * whose link goes to a demo rather than to the thing itself wants to say
     * so. Absent means "Visit", which is what every project said before this
     * existed, so no stored page changes by gaining the field.
     *
     * Verbatim, including any punctuation: the renderer adds nothing. A label
     * ending in a colon is a choice the author makes, not one made for them,
     * because "Visit:" would be wrong for the default.
     */
    urlLabel: z.string().min(1, 'the link label must not be empty').optional(),
    /**
     * The cover image: drawn across the top of the page, above the title, and
     * the picture a shared link shows (`og:image`, in Base.astro).
     *
     * One file for both jobs, deliberately. The page crops it into a fixed
     * 12:5 box (`.doc-cover` in doc.css) and a messaging app crops the whole
     * file to about 1.91:1, so a cover drawn at about 2:1 with its subject in
     * the middle band survives both, and there is no second image to forget
     * to update.
     *
     * Declared long before anything used it, as "List thumbnail", and nothing
     * ever read it or wrote it; no stored page carries one. Giving it this job
     * changes no published page.
     */
    cover: SrcSchema.optional(),
    /**
     * What the cover shows, for a screen reader and for a preview that cannot
     * load the image.
     *
     * Absent means the image is announced as decorative (`alt=""`), which is
     * honest for a cover that only restates the title below it and wrong for
     * one that carries meaning of its own, so the editor asks for it. A label
     * without a cover renders nothing, the same way `urlLabel` without `url`
     * does, so the two are not tied together by a refinement.
     */
    coverAlt: z.string().min(1, 'the cover description must not be empty').optional(),
    /**
     * Keep this page off the site without deleting it.
     *
     * Hidden means hidden, not merely unlisted: `src/lib/site-content.ts`
     * filters these out of the lists the index pages read AND out of the
     * `getStaticPaths` that build the pages themselves, so no page exists at
     * the address at all. Unlisted-but-reachable would leave the URL live
     * for anyone who had it, and for a search engine that already did, which
     * is not what "take it off the site" means.
     *
     * The file stays exactly where it is, so the CMS still lists it, still
     * opens it, and still saves it. Flipping it back puts the page back.
     *
     * NOT called `draft`, though the markdown frontmatter it replaces was.
     * This CMS already has drafts, and they are a different thing: a draft
     * is an unpublished working copy under `src/content/drafts/`, and a
     * hidden page is a published file that chooses not to appear. One word
     * for both would make every sentence about either ambiguous.
     *
     * Absent means visible, so nothing already published changes.
     */
    hidden: z.boolean().optional(),
    /**
     * The slug is still being taken from the title, and may move with it.
     *
     * Set when a page is created and cleared the moment the author renames
     * it by hand. ABSENT MEANS NO — every page written before this existed
     * keeps the address it has, which is the only safe default for a field
     * whose job is to decide whether a URL may change.
     *
     * It is a fact about the document's address, like `hidden` is a fact
     * about its visibility, which is why it lives here and not in the
     * editor's own state: the answer has to survive a reload, and getting
     * it wrong by forgetting means moving a published page's URL.
     *
     * The following only ever happens while the page has NEVER been
     * published — see `slugToFollow` — so this flag being stale on a live
     * page cannot move it.
     */
    slugFromTitle: z.boolean().optional(),
    /**
     * Which surface of the site this document belongs to. Documents only, so
     * 'home' | 'projects' | 'essays'; DocSchema rejects a record section.
     * Optional, because a phase 1 project page written before this existed is
     * still a valid document.
     */
    section: SectionIdSchema.optional(),
    /**
     * End-of-document call to action. Essays already use exactly this shape
     * in their frontmatter; any document may now carry it.
     */
    buttons: z.array(DocButtonSchema).optional(),
  })
  .strict();

export type DocMeta = z.infer<typeof DocMetaSchema>;

/* -------------------------------------------------------------------------- */
/* 3.2 Prose                                                                   */
/* -------------------------------------------------------------------------- */

export const PROSE_BLOCK_KINDS = ['p', 'h2', 'h3', 'quote', 'callout', 'ul', 'ol'] as const;

export const ProseBlockKindSchema = z.enum(PROSE_BLOCK_KINDS);
export type ProseBlockKind = z.infer<typeof ProseBlockKindSchema>;

/**
 * TipTap node type that each block kind maps to. `content` on a ProseBlock is
 * exactly the `content` array of that single top-level node, so a round trip
 * through the editor is:
 *
 *   editor doc  = { type: 'doc', content: [ { type: PROSE_NODE_TYPE[kind],
 *                                             attrs?, content: block.content } ] }
 *   block.content = editorDoc.content[0].content ?? []
 *
 * Heading level is NOT stored in content attrs. It is derived from `kind`
 * through PROSE_HEADING_LEVEL, so h2/h3 cannot disagree with themselves.
 */
export const PROSE_NODE_TYPE: Readonly<Record<ProseBlockKind, string>> = {
  p: 'paragraph',
  h2: 'heading',
  h3: 'heading',
  quote: 'blockquote',
  // A callout is a paragraph in a box. Its CONTENT is a paragraph's, which is
  // what lets links, bold and colour work inside one without a line of extra
  // code; only `kind` and the box around it differ, and `kind` is stored on
  // the ProseBlock rather than inferred from the node.
  callout: 'paragraph',
  ul: 'bulletList',
  ol: 'orderedList',
};

/**
 * What colour a callout is.
 *
 * A CLOSED set, like the highlighter's inks, and for the same reason: each
 * tone is a pair of CSS custom properties with a light and a dark value, so
 * the box follows the theme instead of freezing one. A free colour would have
 * nothing to resolve to in dark mode.
 *
 * These are much lighter than either the highlighter inks or the text
 * palette, because this is a background behind a whole paragraph rather than
 * a stroke behind a few words.
 */
export const CALLOUT_TONES = ['grey', 'yellow', 'blue', 'green', 'pink'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];
export const CalloutToneSchema = z.enum(CALLOUT_TONES);

/** Absent means this. Grey is the quiet one, which is what a callout usually wants. */
export const DEFAULT_CALLOUT_TONE: CalloutTone = 'grey';

export function isCalloutTone(value: unknown): value is CalloutTone {
  return typeof value === 'string' && (CALLOUT_TONES as readonly string[]).includes(value);
}

/**
 * How much air a block asks for above itself.
 *
 * A CLOSED set and not a number, for the reason the callout's tones are a
 * closed set: a free value invites 23px here and 24px two paragraphs later,
 * which nobody can see and which leaves the page quietly uneven forever.
 *
 * Absent means "whatever the blocks either side already do", which is what
 * every document said before this existed, so nothing already written moves
 * by gaining the field.
 *
 * It is a FLOOR, not an addition: the rule is a `margin-top`, which adjoins
 * the previous block's `margin-bottom` and collapses with it, so the gap is
 * the larger of the two. `src/cms/styles/spacing.ts` has the values and the
 * reasoning, including why an empty row was never a substitute for this.
 *
 * Legal on every kind, unlike `tone`: any block can want room above it.
 */
export const BLOCK_SPACES = ['small', 'medium', 'large'] as const;
export type BlockSpace = (typeof BLOCK_SPACES)[number];
export const BlockSpaceSchema = z.enum(BLOCK_SPACES);

export function isBlockSpace(value: unknown): value is BlockSpace {
  return typeof value === 'string' && (BLOCK_SPACES as readonly string[]).includes(value);
}

export const PROSE_HEADING_LEVEL: Readonly<Record<'h2' | 'h3', number>> = { h2: 2, h3: 3 };

/**
 * The only marks allowed on inline text (section 3.2). Text colour is TipTap's
 * `textStyle` mark carrying a `color` attr, because that is what
 * @tiptap/extension-color actually emits. There is no mark literally named
 * "color". See docs/cms-contracts.md.
 */
export const PROSE_MARKS = ['bold', 'italic', 'link', 'textStyle', 'highlight'] as const;
export type ProseMarkType = (typeof PROSE_MARKS)[number];

/**
 * Highlighter inks.
 *
 * A CLOSED set, unlike text colour, which takes any hex. The highlight is
 * drawn as a brush stroke behind the words, and the stroke is a background
 * image whose colour has to be baked into the SVG, so each ink is a class in
 * the stylesheet rather than an inline style. Four pens is also simply what a
 * highlighter is; a colour picker here would invite a shade that buries the
 * text, which is the one thing this must never do.
 *
 * The values are the ink as it is painted BEHIND the glyphs, so they can be
 * this saturated and still leave full-contrast text on top. Laid over the
 * words instead, at any opacity that still reads as colour, the same yellow
 * turns black text olive.
 */
export const HIGHLIGHT_INKS = ['yellow', 'blue', 'green', 'pink'] as const;
export type HighlightInk = (typeof HIGHLIGHT_INKS)[number];
export const HighlightInkSchema = z.enum(HIGHLIGHT_INKS);

/** The default pen, for a highlight stored with no ink or an unknown one. */
export const DEFAULT_HIGHLIGHT_INK: HighlightInk = 'yellow';

export function isHighlightInk(value: unknown): value is HighlightInk {
  return typeof value === 'string' && (HIGHLIGHT_INKS as readonly string[]).includes(value);
}

const ProseBlockObject = z
  .object({
    id: IdSchema,
    kind: ProseBlockKindSchema,
    /**
     * TipTap JSON for the block's content: the `content` array of the node
     * named by PROSE_NODE_TYPE[kind]. Elements are deliberately `unknown`;
     * TipTap owns their shape. Required, and always an array. An empty
     * paragraph is `[]`, never a missing key.
     *
     *   p | h2 | h3  ->  inline nodes: [{ type: 'text', text: '...', marks? }]
     *   quote        ->  [{ type: 'paragraph', content: [inline...] }]
     *   ul | ol      ->  [{ type: 'listItem',
     *                       content: [{ type: 'paragraph', content: [inline...] }] }]
     */
    content: z.array(z.unknown()),
    /**
     * A callout's colour. Ignored on every other kind, and absent means the
     * default, so a callout that has never been recoloured stores nothing.
     */
    tone: CalloutToneSchema.optional(),
    /**
     * Room above this block. Absent means the blocks either side decide it
     * between them, which is what every document said before this existed.
     * See BLOCK_SPACES.
     */
    space: BlockSpaceSchema.optional(),
  })
  .strict();

/**
 * `tone` only means something on a callout, so it is only legal on one, the
 * same way `fill` is only legal on a rect or an ellipse (CanvasItemSchema
 * below). Without this, recolouring a callout and then turning it into a
 * paragraph left the colour behind in the file: invisible, since only a
 * callout renders a tone, and exactly the kind of residue that makes the next
 * reader of the JSON wonder what they are looking at.
 */
export const ProseBlockSchema = ProseBlockObject.superRefine((block, ctx) => {
  if (block.tone !== undefined && block.kind !== 'callout') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tone'],
      message: `\`tone\` is only valid on a callout, not on a "${block.kind}"`,
    });
  }
});

export type ProseBlock = z.infer<typeof ProseBlockSchema>;

/* -------------------------------------------------------------------------- */
/* 3.3 Canvas                                                                  */
/* -------------------------------------------------------------------------- */

export const CANVAS_ITEM_KINDS = ['image', 'video', 'embed', 'shape'] as const;
export const CanvasItemKindSchema = z.enum(CANVAS_ITEM_KINDS);
export type CanvasItemKind = z.infer<typeof CanvasItemKindSchema>;

export const SHAPE_KINDS = ['line', 'rect', 'ellipse', 'squiggle', 'arrow'] as const;
export const ShapeKindSchema = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof ShapeKindSchema>;

/** Media kinds: everything that is not a shape. */
export const MEDIA_ITEM_KINDS = ['image', 'video', 'embed'] as const;
export type MediaItemKind = (typeof MEDIA_ITEM_KINDS)[number];

/**
 * Optional tie from a canvas item to one prose block, drawn as a hand-drawn
 * connector. Both ids must exist in the document for the connector to be
 * drawn; see resolveAnchor. A dangling anchor is NOT a validation error,
 * because deleting a paragraph must not make a document unsaveable. The
 * renderer skips connectors it cannot resolve.
 */
export const AnchorSchema = z
  .object({
    bandId: IdSchema,
    blockId: IdSchema,
    /**
     * Where on the block the connector leaves, as a fraction from its top
     * (0) to its bottom (1).
     *
     * OPTIONAL, and absent is not the same as 0.5. With no value the line
     * picks the point on the block's edge nearest the item, which keeps it
     * short and level and is the right answer almost always. A number pins it
     * instead, for when you want the line to come off a particular line of
     * text. The renderer still keeps it 12px clear of the block's top and
     * bottom edge, so 0 and 1 mean "as high as it goes" rather than a line
     * leaving exactly at the corner.
     */
    at: z.number().min(0, 'at runs from 0 to 1').max(1, 'at runs from 0 to 1').optional(),
  })
  .strict();

export type Anchor = z.infer<typeof AnchorSchema>;

const CanvasItemObject = z
  .object({
    id: IdSchema,
    kind: CanvasItemKindSchema,

    /** Reference px. x may be negative so an item can bleed off the left edge. */
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().positive('w must be greater than 0'),
    h: z.number().finite().positive('h must be greater than 0'),

    /** Degrees, clockwise. Not normalised; -6 and 354 are both legal. */
    rotate: z.number().finite().optional(),
    /** Stacking order. Integer, because it lands in CSS z-index. */
    z: z.number().int('z must be an integer').optional(),

    // media (kind: image | video | embed)
    src: SrcSchema.optional(),
    alt: z.string().optional(),
    caption: z.string().optional(),
    /**
     * How the caption sits under the item. Absent is 'left', which is what
     * every caption did before this existed and what a figcaption does by
     * default, so nothing already written moves.
     */
    captionAlign: z.enum(['left', 'center', 'right']).optional(),
    /**
     * Can the reader click this picture to see it full screen?
     *
     * Off unless asked for. Most pictures on a page are already as large as
     * they need to be, and an enlarge button on every one of them is a
     * cursor change and a tab stop that buys nothing. It is for the figure
     * that cannot be read where it sits: a diagram drawn for the full column,
     * which on a phone becomes a full-width block with six-point type in it.
     *
     * Images only. There is nothing to enlarge about a video, which has its
     * own full-screen button, or a shape.
     */
    zoom: z.boolean().optional(),
    /**
     * The still a video shows before it is played.
     *
     * Without one the browser paints a black rectangle, because the video is
     * `preload="metadata"` and has no frame to show yet. Videos only.
     *
     * Should match the video's own aspect ratio: the element is sized by the
     * item's box, and a poster of a different shape is cropped by the same
     * `object-fit: cover` the video gets.
     */
    poster: SrcSchema.optional(),

    // shape (kind: shape)
    shape: ShapeKindSchema.optional(),
    color: HexColorSchema.optional(),
    /** Omitted means no fill. There is no "none" sentinel. */
    fill: HexColorSchema.optional(),
    strokeWidth: z.number().finite().positive('strokeWidth must be greater than 0').optional(),
    radius: z.number().finite().nonnegative('radius must not be negative').optional(),

    anchor: AnchorSchema.optional(),
  })
  .strict();

/** Keys that only mean something on a shape item. */
const SHAPE_ONLY_KEYS = ['shape', 'color', 'fill', 'strokeWidth', 'radius'] as const;
/** Keys that only mean something on a media item. */
const MEDIA_ONLY_KEYS = ['src', 'alt'] as const;

export const CanvasItemSchema = CanvasItemObject.superRefine((item, ctx) => {
  const reject = (key: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });

  // Before the shape branch, which returns early: these two are wrong on a
  // shape as much as they are on a video. Both document themselves as
  // kind-specific and neither was enforced. There is nothing to enlarge about
  // a video, which has its own full-screen button, and nothing for a poster
  // to stand in front of on an image, which is already the picture.
  if (item.zoom !== undefined && item.kind !== 'image') {
    reject('zoom', '`zoom` is only valid on an image');
  }
  if (item.poster !== undefined && item.kind !== 'video') {
    reject('poster', '`poster` is only valid on a video');
  }

  if (item.kind === 'shape') {
    if (item.shape === undefined) {
      reject('shape', 'a shape item must set `shape`');
    }
    for (const key of MEDIA_ONLY_KEYS) {
      if (item[key] !== undefined) reject(key, `\`${key}\` is not valid on a shape item`);
    }
    if (item.fill !== undefined && item.shape !== 'rect' && item.shape !== 'ellipse') {
      reject('fill', '`fill` is only valid on a rect or ellipse');
    }
    if (item.radius !== undefined && item.shape !== 'rect') {
      reject('radius', '`radius` is only valid on a rect');
    }
    return;
  }

  if (item.src === undefined) {
    reject('src', `\`src\` is required on a canvas item of kind "${item.kind}"`);
  }
  for (const key of SHAPE_ONLY_KEYS) {
    if (item[key] !== undefined) reject(key, `\`${key}\` is only valid on a shape item`);
  }
});

export type CanvasItem = z.infer<typeof CanvasItemSchema>;

/* -------------------------------------------------------------------------- */
/* 3.1 Bands and document                                                      */
/* -------------------------------------------------------------------------- */

export const ProseBandSchema = z
  .object({
    id: IdSchema,
    type: z.literal('prose'),
    blocks: z.array(ProseBlockSchema),
  })
  .strict();

export type ProseBand = z.infer<typeof ProseBandSchema>;

export const CanvasBandSchema = z
  .object({
    id: IdSchema,
    type: z.literal('canvas'),
    /**
     * Reserved vertical space, in reference px. On an overlay band no space is
     * reserved; `height` is still the coordinate box items are positioned in.
     */
    height: z.number().finite().positive('height must be greater than 0'),
    /** Sit over the previous band instead of below it. Never legal on band 0. */
    overlay: z.boolean().optional(),
    /**
     * Clear space kept under the lowest item, in reference px.
     *
     * The band's height follows its contents, which is what stops a shrunk
     * picture leaving a hole. The cost of that is there was no way to ask for
     * room at the BOTTOM any more: anything you added came straight back off
     * on the next edit. This is that room, stated rather than implied, so the
     * fit keeps it. It is also how a captioned item stops colliding with the
     * paragraph underneath, since a caption hangs below the item's own box.
     */
    padBottom: z.number().finite().nonnegative('padBottom must not be negative').optional(),
    items: z.array(CanvasItemSchema),
  })
  .strict();

export type CanvasBand = z.infer<typeof CanvasBandSchema>;

export const BandSchema = z.discriminatedUnion('type', [ProseBandSchema, CanvasBandSchema]);
export type Band = z.infer<typeof BandSchema>;

export const DocSchema = z
  .object({
    version: z.literal(DOC_VERSION),
    meta: DocMetaSchema,
    bands: z.array(BandSchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.meta.section !== undefined && !isDocumentSectionId(doc.meta.section)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['meta', 'section'],
        message: `section "${doc.meta.section}" holds records, not documents; a Doc can only belong to ${DOCUMENT_SECTION_IDS.join(', ')}`,
      });
    }

    const seen = new Map<string, string>();
    const claim = (id: string, path: (string | number)[]) => {
      const where = path.join('.');
      const prior = seen.get(id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `duplicate id "${id}" (already used at ${prior}); ids must be unique across the whole document`,
        });
        return;
      }
      seen.set(id, where);
    };

    doc.bands.forEach((band, b) => {
      claim(band.id, ['bands', b, 'id']);

      if (band.type === 'canvas') {
        if (band.overlay === true && b === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['bands', b, 'overlay'],
            message: 'the first band cannot be an overlay; there is nothing for it to sit over',
          });
        }
        band.items.forEach((item, i) => claim(item.id, ['bands', b, 'items', i, 'id']));
      } else {
        band.blocks.forEach((block, i) => claim(block.id, ['bands', b, 'blocks', i, 'id']));
      }
    });
  });

export type Doc = z.infer<typeof DocSchema>;

/* -------------------------------------------------------------------------- */
/* validateDoc                                                                 */
/* -------------------------------------------------------------------------- */

export type ValidationIssue = {
  /** Dotted path into the document, e.g. `bands.2.items.0.w`. `(root)` for the document itself. */
  path: string;
  message: string;
};

/**
 * Discriminated result. Never throws, so callers switch on `ok` instead of
 * wrapping in try/catch.
 */
export type ValidateResult =
  | { ok: true; doc: Doc }
  | { ok: false; issues: ValidationIssue[] };

export function validateDoc(value: unknown): ValidateResult {
  const parsed = DocSchema.safeParse(value);
  if (parsed.success) return { ok: true, doc: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
}

/** Same contract, starting from the raw file contents. Bad JSON is an issue, not a throw. */
export function validateDocJson(text: string): ValidateResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '(root)', message: `invalid JSON: ${(error as Error).message}` }],
    };
  }
  return validateDoc(value);
}

/** One-line-per-issue rendering, for CLI output and API error strings. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

export function isProseBand(band: Band): band is ProseBand {
  return band.type === 'prose';
}

export function isCanvasBand(band: Band): band is CanvasBand {
  return band.type === 'canvas';
}

export function isShapeItem(item: CanvasItem): boolean {
  return item.kind === 'shape';
}

/**
 * Look up an anchor's target. Returns null when either id is missing or the
 * band is not a prose band, which is the signal to skip drawing the connector.
 */
export function resolveAnchor(
  doc: Doc,
  anchor: Anchor,
): { band: ProseBand; block: ProseBlock } | null {
  const band = doc.bands.find((candidate) => candidate.id === anchor.bandId);
  if (band === undefined || band.type !== 'prose') return null;
  const block = band.blocks.find((candidate) => candidate.id === anchor.blockId);
  if (block === undefined) return null;
  return { band, block };
}

/**
 * Reference px -> percentage of the content width. Use for x and w only; y and
 * h stay in px (section 3.3). One formula, so the editor and the published page
 * cannot drift.
 */
export function refPxToPercent(px: number): number {
  return (px / REFERENCE_WIDTH) * 100;
}

/**
 * Fresh id for a new band, block or item. Short, git-diff friendly, and valid
 * against IdSchema. Conventional prefixes: `b` band, `p` prose block,
 * `i` canvas item.
 */
export function newId(prefix = 'n'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'n';
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  let body: string;
  if (webcrypto !== undefined && typeof webcrypto.getRandomValues === 'function') {
    const bytes = webcrypto.getRandomValues(new Uint8Array(5));
    body = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else {
    body = Math.random().toString(16).slice(2, 12).padEnd(10, '0');
  }
  return `${safePrefix}_${body}`;
}

/**
 * Deterministic 32-bit seed from an id (FNV-1a). This is where a shape's
 * hand-drawn wobble comes from: the same item looks the same in the editor, in
 * the preview and on the published page, forever. Never seed a shape from
 * Math.random() or from an array index.
 */
export function seedFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Frozen asset generator signature (WS-6, imported by WS-1 and WS-4)          */
/* -------------------------------------------------------------------------- */

/**
 * Fallbacks for the shape fields CanvasItem leaves optional. Callers must not
 * invent their own, or the editor and the page will disagree.
 * `color` is the site's --ink.
 */
export const SHAPE_DEFAULTS = {
  color: '#111111',
  strokeWidth: 2,
} as const;

/**
 * Input to the asset generator. Frozen by WS-0; WS-1 and WS-4 both build these
 * and WS-6 consumes them. Every field that affects the drawing is explicit:
 * there are no hidden defaults inside the generator.
 */
export type ShapeSpec = {
  shape: ShapeKind;
  /** Reference px, the item's box. */
  width: number;
  height: number;
  /** Stroke colour, hex. */
  color: string;
  strokeWidth: number;
  /** Stable wobble seed. Use seedFromId(item.id). */
  seed: number;
  /** rect and ellipse only. Omitted means no fill. */
  fill?: string;
  /** rect only. Corner radius in reference px. */
  radius?: number;
};

/**
 * The generator. Returns one complete, self-contained `<svg>` element as a
 * string. Contract, all of it frozen:
 *
 *  - Pure and deterministic: the same ShapeSpec always returns the same string.
 *  - Exactly one root `<svg>` element. No XML declaration, no doctype, no
 *    surrounding whitespace.
 *  - Root attributes: xmlns, viewBox="0 0 {width} {height}", width="100%",
 *    height="100%", preserveAspectRatio="none", aria-hidden="true",
 *    focusable="false".
 *  - No `id` attributes and no `<defs>`. Many of these get inlined into one
 *    page, and ids collide. Arrowheads are drawn as paths, not markers.
 *  - No `<style>` blocks, no CSS classes, no external references, no script.
 *    Presentation goes in attributes so the string is safe to inline in static
 *    HTML and to assign with innerHTML in the editor.
 *  - Strokes use stroke-linecap="round" and fill="none" unless `fill` is set.
 *
 * Safe to inline in HTML as-is: the generator never emits raw input text.
 */
export type ShapeGenerator = (spec: ShapeSpec) => string;

/**
 * The module WS-6 ships, at `src/cms/assets/shapes.ts`. WS-1 and WS-4 import
 * from exactly this path, with exactly these names. Nothing else in WS-6's tree
 * is part of the contract.
 */
export type ShapeAssetsModule = {
  generateShape: ShapeGenerator;
  SHAPE_KINDS: readonly ShapeKind[];
};

/**
 * CanvasItem -> ShapeSpec, applying SHAPE_DEFAULTS and deriving the seed from
 * the item id. Returns null for a non-shape item. The one conversion, so a
 * squiggle drawn in the editor matches the one on the page.
 */
export function shapeSpecFromItem(item: CanvasItem): ShapeSpec | null {
  if (item.kind !== 'shape' || item.shape === undefined) return null;
  const spec: ShapeSpec = {
    shape: item.shape,
    width: item.w,
    height: item.h,
    color: item.color ?? SHAPE_DEFAULTS.color,
    strokeWidth: item.strokeWidth ?? SHAPE_DEFAULTS.strokeWidth,
    seed: seedFromId(item.id),
  };
  if (item.fill !== undefined) spec.fill = item.fill;
  if (item.radius !== undefined) spec.radius = item.radius;
  return spec;
}

/* ========================================================================== */
/* PHASE 2: record collections (docs/cms-sections.md 4)                        */
/* ========================================================================== */

/**
 * Filmography and photography are records, not documents. A film is not a page
 * and should not pretend to be one (docs/cms-sections.md 2), so they get typed
 * fields and a flat JSON file each rather than bands of prose and canvas:
 *
 *   src/content/data/filmography.json   { films: Film[] }
 *   src/content/data/photography.json   { albums: Album[] }
 *
 * Same two rules as the document model above: every object is `.strict()`, and
 * every exported type is `z.infer` of its schema with no hand-written override.
 */

/* -------------------------------------------------------------------------- */
/* Shared record primitives                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A year as it is printed on the site: "2019", or a range like "2018-2019".
 * Tighter than the brief's bare `string` on purpose — a year field that will
 * be concatenated into "SHORT FILM · 2019" should not be able to hold "".
 */
const YEAR_RE = /^\d{4}(?:[-–]\d{4})?$/;

export const YearSchema = z
  .string()
  .regex(YEAR_RE, 'year must be a four-digit year, or a range like "2018-2019"');

/** YouTube video ids are always exactly eleven of these characters. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export const YouTubeIdSchema = z
  .string()
  .regex(YOUTUBE_ID_RE, 'youtubeId must be the 11-character video id, not a URL');

/**
 * Pull a video id out of whatever a human pasted: a bare id, a watch URL, a
 * youtu.be short link, an /embed/, /shorts/, /live/ or /v/ path, with or
 * without www, on youtube.com or youtube-nocookie.com. Returns null when there
 * is no id in there, which is the signal to show "that is not a YouTube link"
 * rather than to save something broken.
 *
 * Lives here, next to YouTubeIdSchema, so the record editor and the migration
 * script cannot disagree about what counts as an id.
 */
export function youtubeIdFromInput(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  if (YOUTUBE_ID_RE.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const candidates: string[] = [];

  if (host === 'youtu.be') {
    candidates.push(url.pathname.slice(1).split('/')[0] ?? '');
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v !== null) candidates.push(v);
    const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (match !== null) candidates.push(match[1] as string);
  }

  for (const candidate of candidates) {
    if (YOUTUBE_ID_RE.test(candidate)) return candidate;
  }
  return null;
}

/** The privacy-preserving embed, matching what the live filmography page builds. */
export function youtubeEmbedUrl(youtubeId: string, options: { autoplay?: boolean } = {}): string {
  const query = options.autoplay === true ? 'autoplay=1&rel=0' : 'rel=0';
  return `https://www.youtube-nocookie.com/embed/${youtubeId}?${query}`;
}

export const YOUTUBE_THUMB_QUALITIES = ['maxresdefault', 'hqdefault', 'mqdefault'] as const;
export type YouTubeThumbQuality = (typeof YOUTUBE_THUMB_QUALITIES)[number];

/** YouTube's own poster frame. The fallback when a film has no uploaded poster. */
export function youtubeThumbUrl(
  youtubeId: string,
  quality: YouTubeThumbQuality = 'maxresdefault',
): string {
  return `https://i.ytimg.com/vi/${youtubeId}/${quality}.jpg`;
}

/**
 * Lowercase kebab-case from arbitrary text, for suggesting an album slug from
 * its title. Returns '' when nothing survives (a title of only punctuation, or
 * only Hangul), which the caller must handle rather than save.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* -------------------------------------------------------------------------- */
/* Filmography                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Values offered in the editor's `kind` field. Suggestions, not an enum: a new
 * kind of film should not need a schema change.
 */
export const FILM_KIND_SUGGESTIONS = ['SHORT FILM', 'TRAILER'] as const;

export const FilmSchema = z
  .object({
    /**
     * Stable record id, independent of the video. The live data uses the
     * YouTube id for both; separating them means re-uploading a film to a new
     * YouTube URL does not orphan its poster or its place in the order.
     */
    id: IdSchema,
    youtubeId: YouTubeIdSchema,
    title: z.string().min(1, 'title must not be empty'),
    note: z.string().optional(),
    /** The small-caps label: "SHORT FILM", "TRAILER". */
    kind: z.string().min(1, 'kind must not be empty'),
    year: YearSchema,
    /** Uploaded poster frame. Omitted means YouTube's own thumbnail. */
    poster: SrcSchema.optional(),
  })
  .strict();

export type Film = z.infer<typeof FilmSchema>;

/** The poster to show, uploaded or YouTube's. One implementation, shared. */
export function filmPosterSrc(film: Film): string {
  return film.poster ?? youtubeThumbUrl(film.youtubeId);
}

export const FilmographySchema = z
  .object({ films: z.array(FilmSchema) })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.films.forEach((film, index) => {
      if (seen.has(film.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['films', index, 'id'],
          message: `duplicate film id "${film.id}"; ids must be unique across the collection`,
        });
      }
      seen.add(film.id);
    });
  });

export type Filmography = z.infer<typeof FilmographySchema>;

/* -------------------------------------------------------------------------- */
/* Photography                                                                 */
/* -------------------------------------------------------------------------- */

export const PhotoSchema = z
  .object({
    id: IdSchema,
    src: SrcSchema,
    alt: z.string().optional(),
    caption: z.string().optional(),
    /** Intrinsic pixel size, from the upload endpoint. */
    w: z.number().int('w must be a whole number of pixels').positive('w must be greater than 0').optional(),
    h: z.number().int('h must be a whole number of pixels').positive('h must be greater than 0').optional(),
  })
  .strict()
  .superRefine((photo, ctx) => {
    // Half a pair is worse than none: a width with no height is not an aspect
    // ratio, and a grid that reserves space from one of them will jump.
    if ((photo.w === undefined) !== (photo.h === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [photo.w === undefined ? 'w' : 'h'],
        message: 'w and h travel together: set both intrinsic dimensions or neither',
      });
    }
  });

export type Photo = z.infer<typeof PhotoSchema>;

const AlbumObject = z
  .object({
    id: IdSchema,
    /** The album page lives at /photography/<slug>/ (docs/cms-sections.md 3.4). */
    slug: z
      .string()
      .regex(SLUG_RE, 'slug must be lowercase kebab-case')
      // A slug is a file name; `fillSlug` cannot build a path from a longer
      // one. Stated here so one schema is the authority instead of three
      // scattered guards.
      .max(MAX_SLUG_LENGTH, `a slug is at most ${MAX_SLUG_LENGTH} characters`),
    title: z.string().min(1, 'title must not be empty'),
    year: YearSchema,
    /** The id of one of this album's photos. Omitted means the first photo. */
    cover: IdSchema.optional(),
    summary: z.string().optional(),
    photos: z.array(PhotoSchema),
  })
  .strict();

export const AlbumSchema = AlbumObject.superRefine((album, ctx) => {
  const seen = new Set<string>();
  album.photos.forEach((photo, index) => {
    if (seen.has(photo.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['photos', index, 'id'],
        message: `duplicate photo id "${photo.id}" within album "${album.slug}"`,
      });
    }
    seen.add(photo.id);
  });

  // A cover pointing at a deleted photo is a broken tile, not a recoverable
  // fallback, so unlike a dangling anchor this one IS an error. Deleting the
  // cover photo must clear `cover` in the same edit.
  if (album.cover !== undefined && !seen.has(album.cover)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cover'],
      message: `cover "${album.cover}" is not the id of a photo in this album`,
    });
  }
});

export type Album = z.infer<typeof AlbumSchema>;

/**
 * The album's cover photo: the chosen one, else the first, else null for an
 * album with no photos yet. The one fallback, so the index tile and the album
 * page cannot show different pictures.
 */
export function albumCoverPhoto(album: Album): Photo | null {
  if (album.cover !== undefined) {
    const chosen = album.photos.find((photo) => photo.id === album.cover);
    if (chosen !== undefined) return chosen;
  }
  return album.photos[0] ?? null;
}

export function albumCoverSrc(album: Album): string | null {
  return albumCoverPhoto(album)?.src ?? null;
}

export const PhotographySchema = z
  .object({ albums: z.array(AlbumSchema) })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    file.albums.forEach((album, index) => {
      if (ids.has(album.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['albums', index, 'id'],
          message: `duplicate album id "${album.id}"; ids must be unique across the collection`,
        });
      }
      ids.add(album.id);

      if (slugs.has(album.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['albums', index, 'slug'],
          message: `duplicate album slug "${album.slug}"; two albums cannot share /photography/${album.slug}/`,
        });
      }
      slugs.add(album.slug);
    });
  });

export type Photography = z.infer<typeof PhotographySchema>;

/** Either record collection's file, for code that handles both. */
export type RecordFile = Filmography | Photography;
/** Either collection's entry. */
export type RecordEntry = Film | Album;

/* -------------------------------------------------------------------------- */
/* Record validators                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Same discriminated-result contract as `ValidateResult`, generically. The
 * payload key is `data` rather than `doc`, because these are not documents;
 * `ValidateResult` keeps its `doc` key so phase 1 code is untouched.
 */
export type ValidateResultOf<T> =
  | { ok: true; data: T }
  | { ok: false; issues: ValidationIssue[] };

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

function runValidate<T>(schema: z.ZodType<T>, value: unknown): ValidateResultOf<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, issues: toIssues(parsed.error) };
}

function runValidateJson<T>(schema: z.ZodType<T>, text: string): ValidateResultOf<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '(root)', message: `invalid JSON: ${(error as Error).message}` }],
    };
  }
  return runValidate(schema, value);
}

export function validateFilmography(value: unknown): ValidateResultOf<Filmography> {
  return runValidate(FilmographySchema, value);
}

export function validateFilmographyJson(text: string): ValidateResultOf<Filmography> {
  return runValidateJson(FilmographySchema, text);
}

export function validatePhotography(value: unknown): ValidateResultOf<Photography> {
  return runValidate(PhotographySchema, value);
}

export function validatePhotographyJson(text: string): ValidateResultOf<Photography> {
  return runValidateJson(PhotographySchema, text);
}

/** One entry at a time, for an editor that validates a field as it is typed. */
export function validateFilm(value: unknown): ValidateResultOf<Film> {
  return runValidate(FilmSchema, value);
}

export function validateAlbum(value: unknown): ValidateResultOf<Album> {
  return runValidate(AlbumSchema, value);
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                   */
/* -------------------------------------------------------------------------- */

function currentYear(): string {
  return String(new Date().getUTCFullYear());
}

/**
 * A new film. Everything has a sane default except `youtubeId`, which is
 * empty and therefore invalid: that is deliberate, because the one thing the
 * editor must ask for before this can be saved is the video. Conventional
 * `newId` prefixes extend with `film`, `album` and `ph` (photo).
 */
export function newFilm(overrides: Partial<Film> = {}): Film {
  return {
    id: newId('film'),
    youtubeId: '',
    title: 'Untitled',
    kind: FILM_KIND_SUGGESTIONS[0],
    year: currentYear(),
    ...overrides,
  };
}

/**
 * A new, empty album. Valid as it stands, so it can be saved before anything
 * is uploaded. The slug is derived from the title when one is not given, and
 * falls back to the record id when the title slugifies to nothing (a title of
 * only Hangul or only punctuation).
 */
export function newAlbum(overrides: Partial<Album> = {}): Album {
  const id = overrides.id ?? newId('album');
  const title = overrides.title ?? 'Untitled album';
  const derived = slugify(title);
  return {
    year: currentYear(),
    photos: [],
    ...overrides,
    id,
    title,
    slug: overrides.slug ?? (derived === '' ? id.replace(/_/g, '-') : derived),
  };
}

/** A new photo from an upload. Pass the endpoint's intrinsic dimensions. */
export function newPhoto(
  src: string,
  dimensions?: { w: number; h: number },
  overrides: Partial<Photo> = {},
): Photo {
  const photo: Photo = { id: newId('ph'), src, ...overrides };
  if (dimensions !== undefined && overrides.w === undefined && overrides.h === undefined) {
    photo.w = dimensions.w;
    photo.h = dimensions.h;
  }
  return photo;
}

/* -------------------------------------------------------------------------- */
/* Narrowing the record unions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `src/cms/sections.ts` types its per-section functions against `RecordFile`
 * and `RecordEntry` so they are callable without narrowing first. These are
 * how a caller that needs the concrete shape gets back to it. They key off a
 * field only one of the two has, so they work on data straight off disk.
 */
export function isFilmography(file: RecordFile): file is Filmography {
  return Array.isArray((file as Filmography).films);
}

export function isPhotography(file: RecordFile): file is Photography {
  return Array.isArray((file as Photography).albums);
}

export function isFilm(entry: RecordEntry): entry is Film {
  return typeof (entry as Film).youtubeId === 'string';
}

export function isAlbum(entry: RecordEntry): entry is Album {
  return Array.isArray((entry as Album).photos);
}

/* ========================================================================== */
/* PHASE 3: the site chrome (the nav bar and the footer)                       */
/* ========================================================================== */

/**
 * The nav bar and the footer, as content.
 *
 * They are not a page and they are not a record collection: they are drawn
 * around EVERY page by `src/layouts/Base.astro`, so they live in one file of
 * their own, `src/content/data/site.json`, and a change to it changes every
 * page of the site at once. The file's shape is `SiteChrome` below.
 *
 * Two rules carry over from the rest of this file: every object is `.strict()`,
 * and every exported type is `z.infer` of its schema. Two more are specific to
 * this shape and are the point of it:
 *
 *  1. **An icon is a KEY, never artwork.** `SOCIAL_ICONS` names the five that
 *     exist; the SVG for each lives in code (`src/cms/site-icons.ts`) and is
 *     selected by key. Nobody editing the footer is ever asked to paste a
 *     bezier, and an unknown key is a validation error with the list in it.
 *     The theme toggle's sun and moon are in that same file for that same
 *     reason, which is why `ThemeToggleSchema` has no artwork in it either.
 *  2. **The year is not stored.** `footer.copyright` holds the whole line with
 *     a literal `{year}` token in it — "© {year} Ryan Choi" — and
 *     `renderCopyright` substitutes the year at render time. Storing "© 2026
 *     Ryan Choi" would freeze the year the day it was typed; storing only the
 *     name would put the ©, the spacing and the word order back into code,
 *     which is the thing this file exists to get out of code. A line with no
 *     token renders verbatim, so the token is a facility and not a ceremony.
 */

/** The social icons the site has artwork for. The artwork is in code. */
export const SOCIAL_ICONS = ['github', 'linkedin', 'x', 'youtube', 'email'] as const;

export const SocialIconSchema = z.enum(SOCIAL_ICONS, {
  errorMap: () => ({
    message:
      `icon must be one of ${SOCIAL_ICONS.join(', ')} — ` +
      'the drawing for each one lives in code, so there is no SVG to paste',
  }),
});

export type SocialIcon = z.infer<typeof SocialIconSchema>;

export function isSocialIcon(value: string): value is SocialIcon {
  return (SOCIAL_ICONS as readonly string[]).includes(value);
}

/**
 * Caps on the two lists. The nav is a centred row on a 1440px design and a
 * wrapped row on a phone; past eight links it is a menu, which is a redesign
 * and not a content edit. The footer row is capped at the same number for the
 * same reason, not because the icons run out.
 */
export const MAX_NAV_LINKS = 8;
export const MAX_SOCIAL_LINKS = 8;

export const NavLinkSchema = z
  .object({
    /** As printed. The site's own CSS does not uppercase it, so "PROJECTS" is stored as typed. */
    label: z.string().min(1, 'a nav link needs a label'),
    href: HrefSchema,
  })
  .strict();

export type NavLink = z.infer<typeof NavLinkSchema>;

export const SocialLinkSchema = z
  .object({
    /** The accessible name: it becomes `aria-label` and `title` on the link. */
    name: z.string().min(1, 'a social link needs a name; it is what a screen reader reads out'),
    href: HrefSchema,
    icon: SocialIconSchema,
  })
  .strict();

export type SocialLink = z.infer<typeof SocialLinkSchema>;

export const SiteFooterSchema = z
  .object({
    /** The whole line. `{year}` is substituted by `renderCopyright`. */
    copyright: z.string().min(1, 'the copyright line must not be empty'),
    social: z
      .array(SocialLinkSchema)
      .max(MAX_SOCIAL_LINKS, `the footer holds at most ${MAX_SOCIAL_LINKS} social links`),
  })
  .strict();

export type SiteFooter = z.infer<typeof SiteFooterSchema>;

/**
 * The wordmark: the site's own name, top left, and where clicking it goes.
 *
 * `label` is also the site name in `<title>` and `og:title`
 * (`src/layouts/Base.astro`), because it is the same name and keeping a second
 * hardcoded copy of it is the thing this file exists to stop.
 */
export const WordmarkSchema = z
  .object({
    label: z.string().min(1, 'the wordmark is the site’s name; it cannot be empty'),
    href: HrefSchema,
  })
  .strict();

export type Wordmark = z.infer<typeof WordmarkSchema>;

/**
 * What a visitor who has never touched the toggle sees. `system` follows their
 * operating system, which is what the site has always done; the other two
 * overrule it. A visitor's own saved choice always wins over all three.
 */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export const ThemeChoiceSchema = z.enum(THEME_CHOICES, {
  errorMap: () => ({
    message: `the starting theme must be one of ${THEME_CHOICES.join(', ')}`,
  }),
});

export type ThemeChoice = z.infer<typeof ThemeChoiceSchema>;

/**
 * The light/dark control in the top right.
 *
 * Two fields, because they are the only two things about it that are content.
 * The sun and the moon are artwork and live in code (`src/cms/site-icons.ts`),
 * exactly as the social icons do, for the reason given at the top of this
 * section.
 *
 * `show: false` removes the control, not the themes: a visitor's saved choice
 * and `initial` still decide which one they get, and the site still answers to
 * the operating system when `initial` is `system`. So hiding it is "I pick the
 * theme", never "the site has one theme".
 */
export const ThemeToggleSchema = z
  .object({
    show: z.boolean(),
    initial: ThemeChoiceSchema,
  })
  .strict();

export type ThemeToggle = z.infer<typeof ThemeToggleSchema>;

/**
 * Key order is the order these things appear on the page — wordmark, nav,
 * toggle, then the footer — because `serialiseSiteChrome` writes what zod
 * returned, so this order is the order of the lines in `site.json` and of every
 * diff of it.
 */
/**
 * The body size, site-wide and per section.
 *
 * It lives on the site chrome rather than in a file of its own because it is
 * the same KIND of thing as the nav and the footer: one setting, edited once
 * under Home, applied to every page at once. A second single-file store with
 * its own draft, its own publish and its own conflict detection would be a
 * copy of this one for no gain.
 *
 * OPTIONAL, AND ABSENT MEANS THE DESIGN'S OWN SIZE. Every site.json written
 * before this existed has no `type` key, and must stay valid and stay
 * rendering exactly as it does. `src/cms/styles/type-scale.ts` generates
 * nothing at all for the default, so "no key" and "17.5 everywhere" are the
 * same site, byte for byte.
 *
 * `sections` holds only the ones that differ from `size`. That is what makes
 * "apply everywhere" and "apply to these" one operation with two arguments
 * rather than two code paths: the first sets `size`, the second sets keys.
 */
export const TypeScaleSchema = z
  .object({
    size: z
      .number()
      .min(TYPE_SIZE_MIN, `body text below ${TYPE_SIZE_MIN}px is not reading`)
      .max(TYPE_SIZE_MAX, `body text above ${TYPE_SIZE_MAX}px is a heading`)
      .refine(
        (value) => Number.isInteger(value * 2),
        'body size moves in half pixels: 16, 16.5, 17',
      ),
    // Required, not defaulted. `.default({})` makes zod's input type differ
    // from its output type, which propagates into `ValidateResultOf` and
    // breaks every caller of `validateSiteChrome` with an unreadable error
    // about two unrelated types of the same name. `type` itself is optional,
    // which is where "nothing set" is expressed; a `type` that exists always
    // has both keys, and the only writer is `applyBodySize`.
    sections: z.record(
      SectionIdSchema,
      z
        .number()
        .min(TYPE_SIZE_MIN)
        .max(TYPE_SIZE_MAX)
        .refine((value) => Number.isInteger(value * 2), 'half pixels only'),
    ),
  })
  .strict();

export type TypeScale = z.infer<typeof TypeScaleSchema>;

export const SiteChromeSchema = z
  .object({
    wordmark: WordmarkSchema,
    nav: z
      .array(NavLinkSchema)
      .max(MAX_NAV_LINKS, `the nav bar holds at most ${MAX_NAV_LINKS} links`),
    themeToggle: ThemeToggleSchema,
    footer: SiteFooterSchema,
    type: TypeScaleSchema.optional(),
  })
  .strict();

export type SiteChrome = z.infer<typeof SiteChromeSchema>;

/**
 * The theme a first-time visitor gets, given the setting and what their
 * operating system asks for.
 *
 * One implementation so the page's own pre-paint script, the editor's scenery
 * and anything else that needs to answer "which one shows first?" cannot
 * disagree. The script in `Base.astro` is `is:inline` and cannot import this,
 * so it restates these three lines; this is the version under test.
 */
export function resolveInitialTheme(initial: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (initial === 'light') return 'light';
  if (initial === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/* -------------------------------------------------------------------------- */
/* The copyright year                                                          */
/* -------------------------------------------------------------------------- */

/** The literal token `footer.copyright` may carry in place of the year. */
export const COPYRIGHT_YEAR_TOKEN = '{year}';

/**
 * A stored YYYY-MM-DD as a date a person reads: "July 7, 2026".
 *
 * One implementation, used by the published page and by the editor's Date
 * field, so what the inspector shows is the string the page will print rather
 * than a second opinion about it. That is also what settles the question the
 * field exists to settle: a month spelled out cannot be read in two orders,
 * where 07/07/2026 leaves you counting on your fingers.
 *
 * Parsed and formatted in UTC on purpose. `new Date('2026-07-07')` is midnight
 * UTC, and formatting that in a timezone behind UTC prints the 6th.
 *
 * Anything that is not a real date comes back unchanged: this is for display,
 * and showing the raw text beats showing "Invalid Date".
 */
export function formatLongDate(date: string): string {
  if (!DATE_RE.test(date) || !isRealCalendarDate(date)) return date;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The stored line with the year filled in. Every occurrence of `{year}` is
 * replaced; a line without the token comes back unchanged.
 *
 * One implementation, so the published footer, the preview and the editor's own
 * scenery cannot print three different years.
 */
export function renderCopyright(copyright: string, year: number | string): string {
  return copyright.split(COPYRIGHT_YEAR_TOKEN).join(String(year));
}

/* -------------------------------------------------------------------------- */
/* Which nav link is the current page                                          */
/* -------------------------------------------------------------------------- */

/**
 * The path a nav link marks as current, or null when it cannot mark anything
 * (an off-site link, a `mailto:`, a bare `#fragment`).
 *
 * Derived from the href rather than stored beside it: a second field would be a
 * second thing to keep in step, and "`/projects/` highlights on `/projects/`
 * and everything under it" is a rule, not a per-link decision. The trailing
 * slash is dropped so `/projects/` and `/projects` are the same link.
 */
export function navMatchFor(href: string): string | null {
  if (!href.startsWith('/')) return null;
  const path = (href.split('#')[0] as string).split('?')[0] as string;
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** True when `pathname` is this link's page, or a page under it. */
export function isNavCurrent(href: string, pathname: string): boolean {
  const match = navMatchFor(href);
  if (match === null) return false;
  if (match === '/') return pathname === '/';
  return pathname === match || pathname.startsWith(`${match}/`);
}

/* -------------------------------------------------------------------------- */
/* Site chrome validators and factories                                        */
/* -------------------------------------------------------------------------- */

export function validateSiteChrome(value: unknown): ValidateResultOf<SiteChrome> {
  return runValidate(SiteChromeSchema, value);
}

export function validateSiteChromeJson(text: string): ValidateResultOf<SiteChrome> {
  return runValidateJson(SiteChromeSchema, text);
}

/** One link at a time, for an editor validating a row as it is typed. */
export function validateNavLink(value: unknown): ValidateResultOf<NavLink> {
  return runValidate(NavLinkSchema, value);
}

export function validateSocialLink(value: unknown): ValidateResultOf<SocialLink> {
  return runValidate(SocialLinkSchema, value);
}

/**
 * A new nav link. Valid as it stands — label "SECTION", pointing at the home
 * page — so adding one never makes the file unsaveable before it is filled in.
 */
export function newNavLink(overrides: Partial<NavLink> = {}): NavLink {
  return { label: 'SECTION', href: '/', ...overrides };
}

/**
 * A new social link. `href` is deliberately empty, and therefore invalid: the
 * one thing the editor must ask for before this can be saved is the address,
 * exactly as `newFilm` does with its video. Pass `name` from
 * `SOCIAL_ICON_LABELS` in `src/cms/site-icons.ts`.
 */
export function newSocialLink(overrides: Partial<SocialLink> = {}): SocialLink {
  return { name: 'Link', href: '', icon: SOCIAL_ICONS[0], ...overrides };
}
