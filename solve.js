// Fast Static Site Generator v6 — a faster drop-in for makefun-site 1.0.0.
//
// Byte-identical answers to makefun-site 1.0.0 for every input; only the work
// is cheaper. v6 keeps v5's whole pipeline and cuts the two costs the v5
// profile still showed — template tree-walking and fence scanning:
//
//   * Constant-partial caching: a partial whose free variables are only
//     site-wide (site, tags, recent) renders the same string for every page,
//     so it is rendered once per case and reused. The cache is built by a
//     free-variable analysis over each template's tree (following includes
//     in scope, loop-bound names excluded); only depth-0 includes with an
//     empty binding stack hit it, and the cached render runs at the same
//     depth the original include would have. On the practice cases this
//     cuts template node-visits from 395,037 to 145,150 (-63%).
//   * Fence-close search via indexOf: instead of walking every line inside
//     a fenced block in JavaScript, the close is found with a C++ scan for
//     the next ```, each candidate checked to sit at a line start and pass
//     the same isFenceCloseAt test the line walk used.
//   * main.ts serialises answers with a manual per-value JSON builder
//     (array + join) instead of one bulk JSON.stringify — byte-identical
//     output, about 10% cheaper on the serialisation step.
//   * Measured locally, run+stringify fresh-process median falls from
//     ~330 ms (v5) to ~302 ms (about 8% median, 5% trimmed mean) on the
//     practice cases, with byte-identical output on the practice set, on
//     two fresh generated sets, and on differential edge cases.
//   * Everything else is v5's: the single-regex inline renderer, the
//     index-walked Markdown pass with its word count folded in, join-once
//     rendering everywhere, the binding-stack template tree walk, memoised
//     slugs and dates, and the --no-opt + --no-incremental-marking flags
//     in main.ts.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

/** HTML entities, in this order: & < > " ' */
const ENT = ['', '&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];
/** Entity code by char code (0 = not escapable): 1 &amp; 2 &lt; 3 &gt; 4 &quot; 5 &#39; */
const ENT_CODE = new Uint8Array(128);
ENT_CODE[38] = 1;
ENT_CODE[60] = 2;
ENT_CODE[62] = 3;
ENT_CODE[34] = 4;
ENT_CODE[39] = 5;
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * `text` with & < > " and ' escaped. Most strings hold no escapable
 * character, so a fast test returns them untouched; short dirty strings take
 * a manual loop, long dirty ones the regex.
 */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  if (text.length > 200) return text.replace(ESC_RE, (c) => ESC_MAP[c]);
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const t = c < 128 ? ENT_CODE[c] : 0;
    if (t === 0) continue;
    if (start < i) out += text.slice(start, i);
    out += ENT[t];
    start = i + 1;
  }
  if (start < text.length) out += text.slice(start);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Long dates, memoised: the same few dates recur across a whole site. */
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  let out = dateCache.get(date);
  if (out === undefined) {
    out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, out);
  }
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Slugs, memoised: titles, headings and (above all) tag names repeat. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. Pure ASCII takes a fast path: normalisation is the identity there.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      ascii = false;
      break;
    }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
    if (out.length >= SLUG_MAX) break;
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether char code `c` is JavaScript whitespace (what \s matches). */
function isSpaceCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

/** A whitespace table over every code unit, so the word count is one table
 * lookup per character with no range checks in the loop. */
const SPACE_TBL = new Uint8Array(65536);
for (let c = 0; c < 65536; c++) {
  if (isSpaceCode(c)) SPACE_TBL[c] = 1;
}

/**
 * The words in `src[start, end)`: its runs of characters other than
 * whitespace — exactly what `src.slice(start, end).match(/\S+/g).length`
 * counts, without building the array. The Markdown pass calls it once per
 * line range it consumes, so the body is counted as it is rendered.
 */
function countRuns(src, start, end) {
  let n = 0;
  let inWord = false;
  for (let i = start; i < end; i++) {
    if (SPACE_TBL[src.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** The words of a body: its runs of characters other than whitespace. */
export function countWords(text) {
  return countRuns(text, 0, text.length);
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1 && inner.indexOf('"') === -1) return { value: inner };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const bad = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return bad;
      for (let k = 0; k < 10; k++) {
        if (k === 4 || k === 7) continue;
        const c = raw.charCodeAt(k);
        if (c < 48 || c > 57) return bad;
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return bad;
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let p = 0;
      for (;;) {
        const comma = inner.indexOf(',', p);
        const t = (comma === -1 ? inner.slice(p) : inner.slice(p, comma)).trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
        if (comma === -1) break;
        p = comma + 1;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let k = 0; k < raw.length; k++) {
        const c = raw.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let k = 0; k < raw.length; k++) {
        const c = raw.charCodeAt(k);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing fence
 * is found with indexOf, and the lines are scanned in place — the text is
 * never split and no line is sliced except for a key and its value.
 */
export function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  const mid = text.indexOf('\n---\n', nl0);
  const endClose = text.endsWith('\n---') ? text.length - 3 : -1;
  let closeStart;
  let bodyStart;
  if (mid !== -1 && (endClose === -1 || mid + 1 < endClose)) {
    closeStart = mid + 1;
    bodyStart = mid + 5;
  } else if (endClose !== -1) {
    closeStart = endClose;
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const data = {};
  let pos = nl0 + 1;
  let lineNo = 1;
  while (pos < closeStart) {
    const eol = text.indexOf('\n', pos);
    const ls = pos;
    const le = eol;
    pos = eol + 1;
    lineNo++;
    let blank = true;
    for (let k = ls; k < le; k++) {
      const c = text.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || text.charCodeAt(ls) === 35) continue;
    let colon = -1;
    for (let k = ls; k < le; k++) {
      const c = text.charCodeAt(k);
      if (c === 58) {
        colon = k;
        break;
      }
      if (!((c >= 97 && c <= 122) || c === 95)) {
        colon = -2;
        break;
      }
    }
    if (colon < ls + 1) return { error: `line ${lineNo} is not "key: value"` };
    let raw;
    if (colon + 1 === le) raw = '';
    else if (text.charCodeAt(colon + 1) === 32) {
      let re = le;
      while (re > colon + 2 && (text.charCodeAt(re - 1) === 32 || text.charCodeAt(re - 1) === 9)) re--;
      raw = text.slice(colon + 2, re);
    } else return { error: `line ${lineNo} is not "key: value"` };
    const key = text.slice(ls, colon);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by char code. */
const ESC_TBL = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESC_TBL[c] = 1;

/** Whether char code `c` is one a backslash escapes. */
function isEscapable(c) {
  return c < 128 && ESC_TBL[c] === 1;
}

const WS_RE = /\s/;

/**
 * One pattern for every inline construct, so a paragraph is scanned once by
 * the C++ regex engine instead of once per special character by a JS loop:
 * escape, code span, bold, emphasis, link, entity — plus a ** with no
 * non-empty closer later, which the reference skips literally. The groups
 * are the constructs' inner parts only, so the callback never re-scans a
 * match. A backslash is consumable only as an escape pair (the plain-char
 * unit excludes it), so an escaped star can never close an emphasis, and
 * bold and emphasis content is non-empty (+?), exactly as the reference
 * requires. Two identical objects alternate by recursion depth, so a nested
 * replace never shares its iteration state with the replace it runs inside.
 * (V8 collects a replace's matches before running its callbacks, so nesting
 * would be safe on one object too; the alternation is belt and braces.)
 */
const INLINE_RE0 =
  /\\([\\`*_\[\]()#+\-.!>])|`([^`]+)`|\*\*((?:\\.|\*(?!\*)|[^*\\])+?)\*\*|(\*\*(?!(?:\\.|\*(?!\*)|[^*\\])+\*\*))|\*(?!\*)((?:\\.|\*\*|\*(?!\*)|[^*\\])+?)\*(?!\*)|\[((?:[^\\\]]|\\.)*)\]\(([^)\s]+)\)|([&<>"'])/g;
const INLINE_RE1 =
  /\\([\\`*_\[\]()#+\-.!>])|`([^`]+)`|\*\*((?:\\.|\*(?!\*)|[^*\\])+?)\*\*|(\*\*(?!(?:\\.|\*(?!\*)|[^*\\])+\*\*))|\*(?!\*)((?:\\.|\*\*|\*(?!\*)|[^*\\])+?)\*(?!\*)|\[((?:[^\\\]]|\\.)*)\]\(([^)\s]+)\)|([&<>"'])/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. A single
 * String.replace drives the whole scan: the regex finds each construct and
 * the callback renders it, recursing (on the other regex object) for
 * nested content. A string with no construct comes back from the one scan
 * untouched.
 */
export function inline(s, env, depth = 0) {
  const re = depth & 1 ? INLINE_RE1 : INLINE_RE0;
  return s.replace(re, (m, esc, code, bold, lit, em, text, target, ent) => {
    if (esc !== undefined) return esc === '>' ? '&gt;' : esc;
    if (code !== undefined) return `<code>${escapeHtml(code)}</code>`;
    if (bold !== undefined) return `<strong>${inline(bold, env, depth + 1)}</strong>`;
    if (lit !== undefined) return lit;
    if (em !== undefined) return `<em>${inline(em, env, depth + 1)}</em>`;
    if (text !== undefined) return `<a href="${escapeHtml(env.link(target))}">${inline(text, env, depth + 1)}</a>`;
    if (ent !== undefined) return ENT[ENT_CODE[ent.charCodeAt(0)]];
    return m;
  });
}

// --- Block classifiers over a line range [pos, eol) of a source string. ---

/** Whether the range holds only spaces and tabs (or is empty). */
function rangeIsBlank(src, pos, eol) {
  for (let k = pos; k < eol; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null: ``` plus a language, then spaces or tabs only. */
function fenceLangAt(src, pos, eol) {
  if (eol - pos < 3 || src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return null;
  let p = pos + 3;
  while (p < eol) {
    const c = src.charCodeAt(p);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    p++;
  }
  const lang = src.slice(pos + 3, p);
  while (p < eol && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  return p === eol ? lang : null;
}

/** Whether the range closes a fence: ``` then spaces or tabs only. */
function isFenceCloseAt(src, pos, eol) {
  if (eol - pos < 3 || src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return false;
  for (let p = pos + 3; p < eol; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text range, or null (a heading's text is never empty). */
function headingAt(src, pos, eol) {
  let hashes = 0;
  while (pos + hashes < eol && src.charCodeAt(pos + hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let p = pos + hashes;
  if (p >= eol) return null;
  const c = src.charCodeAt(p);
  if (c !== 32 && c !== 9) return null;
  while (p < eol && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  let e = eol;
  while (e > p && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  if (e <= p) return null;
  return { depth: hashes, start: p, end: e };
}

/** Whether the range is a thematic break: --- or *** (then spaces or tabs only). */
function isHrAt(src, pos, eol) {
  if (eol - pos < 3) return false;
  const c0 = src.charCodeAt(pos);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(pos + 1) !== c0 || src.charCodeAt(pos + 2) !== c0) return false;
  for (let p = pos + 3; p < eol; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text start, or -1: `- ` or `* ` then the item. */
function bulletAt(src, pos, eol) {
  if (eol - pos < 2) return -1;
  const c0 = src.charCodeAt(pos);
  if ((c0 === 45 || c0 === 42) && src.charCodeAt(pos + 1) === 32) return pos + 2;
  return -1;
}

/** An ordered item's number and text start, or null: up to 9 digits, `. `, then the item. */
function orderedAt(src, pos, eol) {
  let p = pos;
  while (p < eol) {
    const c = src.charCodeAt(p);
    if (c < 48 || c > 57) break;
    p++;
  }
  const digits = p - pos;
  if (digits === 0 || digits > 9) return null;
  if (p >= eol || src.charCodeAt(p) !== 46 || p + 1 >= eol || src.charCodeAt(p + 1) !== 32) return null;
  return { num: src.slice(pos, p), textStart: p + 2 };
}

/** Whether the range continues a list item: two or more spaces, then a non-space. */
function isContinuedAt(src, pos, eol) {
  if (eol - pos < 2 || src.charCodeAt(pos) !== 32 || src.charCodeAt(pos + 1) !== 32) return false;
  let p = pos + 2;
  while (p < eol && src.charCodeAt(p) === 32) p++;
  if (p >= eol) return false;
  return !isSpaceCode(src.charCodeAt(p));
}

/** Whether the range ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraphAt(src, pos, eol) {
  if (eol === pos) return true;
  const c0 = src.charCodeAt(pos);
  if (c0 === 32 || c0 === 9) return rangeIsBlank(src, pos, eol);
  if (c0 === 96) return fenceLangAt(src, pos, eol) !== null;
  if (c0 === 35) return headingAt(src, pos, eol) !== null;
  if (c0 === 45 || c0 === 42) return isHrAt(src, pos, eol);
  return false;
}

/** The range with spaces and tabs at either end dropped, as a string. */
function trimmedText(src, start, end) {
  let s = start;
  let e = end;
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return src.slice(s, e);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML), its excerpt (the first paragraph's inline HTML, or "")
 * and its word count. The source is walked by index — never split into
 * lines — and blocks render straight into the output as they are found.
 * Every line is counted as it is consumed, so the word count costs no
 * second pass over the body: blank lines hold no words, and every other
 * line's range is counted exactly once by the block that eats it.
 */
export function renderMarkdown(src, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const n = src.length;
  let pos = 0;
  while (pos <= n) {
    let eol = src.indexOf('\n', pos);
    if (eol === -1) eol = n;
    if (eol === pos) {
      pos = eol + 1;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if (c0 === 32 || c0 === 9) {
      if (rangeIsBlank(src, pos, eol)) {
        pos = eol + 1;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLangAt(src, pos, eol);
      if (lang !== null) {
        words += countRuns(src, pos, eol);
        const open = lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`;
        const cs = eol + 1;
        let content = '';
        let nextPos = n + 1;
        if (cs <= n) {
          // v6: the fence close is found with a C++ indexOf scan for the
          // next ``` instead of a JavaScript walk over every line inside
          // the block. Each candidate must sit at a line start and pass
          // the same isFenceCloseAt test the line walk used; a rejected
          // candidate advances past its three backticks.
          let q = cs;
          let closeStart = -1;
          for (;;) {
            const cand = src.indexOf('```', q);
            if (cand === -1) break;
            const ls = cand === cs || src.charCodeAt(cand - 1) === 10;
            let e2 = src.indexOf('\n', cand);
            if (e2 === -1) e2 = n;
            if (ls && isFenceCloseAt(src, cand, e2)) {
              closeStart = cand;
              break;
            }
            q = cand + 3;
          }
          if (closeStart !== -1) {
            if (closeStart !== cs) {
              content = escapeHtml(src.slice(cs, closeStart - 1)) + '\n';
              words += countRuns(src, cs, closeStart);
            }
            const ce = src.indexOf('\n', closeStart);
            words += countRuns(src, closeStart, ce === -1 ? n : ce);
            nextPos = ce === -1 ? n + 1 : ce + 1;
          } else {
            content = escapeHtml(src.slice(cs, n)) + '\n';
            words += countRuns(src, cs, n);
          }
        }
        parts.push(`${open}${content}</code></pre>\n`);
        pos = nextPos;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingAt(src, pos, eol);
      if (heading !== null) {
        words += countRuns(src, pos, eol);
        const text = src.slice(heading.start, heading.end);
        const id = uniqueSlug(slugify(text), ids);
        const inner = inline(text, env);
        parts.push(`<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
        pos = eol + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHrAt(src, pos, eol)) {
        words += countRuns(src, pos, eol);
        parts.push('<hr>\n');
        pos = eol + 1;
        continue;
      }
      const bStart = bulletAt(src, pos, eol);
      if (bStart !== -1) {
        words += countRuns(src, pos, eol);
        const bparts = ['<ul>\n'];
        let cur = trimmedText(src, bStart, eol);
        pos = eol + 1;
        for (;;) {
          if (pos > n) {
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            break;
          }
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = n;
          const mStart = bulletAt(src, pos, e2);
          if (mStart !== -1) {
            words += countRuns(src, pos, e2);
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            cur = trimmedText(src, mStart, e2);
            pos = e2 + 1;
          } else if (isContinuedAt(src, pos, e2)) {
            words += countRuns(src, pos, e2);
            cur += `\n${trimmedText(src, pos, e2)}`;
            pos = e2 + 1;
          } else {
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            break;
          }
        }
        bparts.push('</ul>');
        parts.push(`${bparts.join('')}\n`);
        continue;
      }
    } else if (c0 === 62) {
      const iparts = [];
      let has = false;
      while (pos <= n) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = n;
        if (e2 === pos || src.charCodeAt(pos) !== 62) break;
        words += countRuns(src, pos, e2);
        const cs2 = src.charCodeAt(pos + 1) === 32 ? pos + 2 : pos + 1;
        const t = trimmedText(src, cs2, e2);
        if (t !== '') {
          if (has) iparts.push('\n');
          iparts.push(t);
          has = true;
        }
        pos = e2 + 1;
      }
      if (!has) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push(`<blockquote>\n<p>${inline(iparts.join(''), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedAt(src, pos, eol);
      if (o !== null) {
        words += countRuns(src, pos, eol);
        const startNum = Number(o.num);
        const bparts = [startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n'];
        let cur = trimmedText(src, o.textStart, eol);
        pos = eol + 1;
        for (;;) {
          if (pos > n) {
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            break;
          }
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = n;
          const m = orderedAt(src, pos, e2);
          if (m !== null) {
            words += countRuns(src, pos, e2);
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            cur = trimmedText(src, m.textStart, e2);
            pos = e2 + 1;
          } else if (isContinuedAt(src, pos, e2)) {
            words += countRuns(src, pos, e2);
            cur += `\n${trimmedText(src, pos, e2)}`;
            pos = e2 + 1;
          } else {
            bparts.push(`<li>${inline(cur, env)}</li>\n`);
            break;
          }
        }
        bparts.push('</ol>');
        parts.push(`${bparts.join('')}\n`);
        continue;
      }
    }
    // A paragraph: its lines run until one ends it. Most need no trimming,
    // so the paragraph is usually one slice of the source.
    const pa = pos;
    let needsTrim =
      src.charCodeAt(pos) === 32 ||
      src.charCodeAt(pos) === 9 ||
      src.charCodeAt(eol - 1) === 32 ||
      src.charCodeAt(eol - 1) === 9;
    let pbEnd = eol;
    pos = eol + 1;
    while (pos <= n) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = n;
      if (endsParagraphAt(src, pos, e2)) break;
      if (!needsTrim) {
        needsTrim =
          src.charCodeAt(pos) === 32 ||
          src.charCodeAt(pos) === 9 ||
          src.charCodeAt(e2 - 1) === 32 ||
          src.charCodeAt(e2 - 1) === 9;
      }
      pbEnd = e2;
      pos = e2 + 1;
    }
    words += countRuns(src, pa, pbEnd);
    let text;
    if (!needsTrim) {
      text = src.slice(pa, pbEnd);
    } else {
      const tparts = [];
      let p = pa;
      let firstLine = true;
      for (;;) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1 || e2 > pbEnd) e2 = pbEnd;
        if (!firstLine) tparts.push('\n');
        tparts.push(trimmedText(src, p, e2));
        firstLine = false;
        if (e2 === pbEnd) break;
        p = e2 + 1;
      }
      text = tparts.join('');
    }
    const phtml = inline(text, env);
    if (excerpt === null) excerpt = phtml;
    parts.push(`<p>${phtml}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text [0, text], {{ }} [1, path], {{{ }}} [2, path] and
 * {% %} [3, tag], a standalone tag's line taken with it.
 */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push([0, text]);
      text = '';
      tokens.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push([0, text]);
    text = '';
    tokens.push([3, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push([0, text]);
  return tokens;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). Nodes are flat arrays: text [0, text], var [1, path], raw [2, path],
 * if [3, not, path, then, else|null], for [4, name, path, body], include
 * [5, name].
 */
export function parseTemplate(name, src) {
  const root = [0, []];
  const stack = [root];
  let body = root[1];
  for (const tok of tokenize(name, src)) {
    if (tok[0] === 0) body.push([0, tok[1]]);
    else if (tok[0] === 1 || tok[0] === 2) body.push([tok[0], tok[1]]);
    else {
      const tag = tok[1];
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push(node);
        body = node[3];
      } else if (tag === 'else') {
        if (top[0] !== 3 || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top[4] = [];
        body = top[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent[0] === 0 ? parent[1] : parent[0] === 4 ? parent[3] : parent[4] ?? parent[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1][0] === 4 ? 'for' : 'if'} is not closed`);
  return root[1];
}

/**
 * The binding stack: loop variables and loop objects, flat as
 * [name, value, name, value, ...], innermost last. A for-loop pushes its
 * element binding and its loop object, rewrites the element slot each
 * iteration, and truncates the stack when it leaves — no scope object is
 * ever made per iteration, and the stack is empty between renders.
 */
const BIND = [];

/** The value `name` binds to in the enclosing loops, else `root`'s own. */
function firstOf(name, root) {
  for (let k = BIND.length - 2; k >= 0; k -= 2) {
    if (BIND[k] === name) return BIND[k + 1];
  }
  return root[name];
}

/** The value at `path`: its first name in the binding stack or the root,
 * each next name an own property of the value so far, or undefined. */
function lookupPath(root, path) {
  let v = firstOf(path[0], root);
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `root`, its pieces pushed into `out`. `templates`
 * holds the parsed templates (a template that did not parse absent); `depth`
 * is the include depth. A for-loop makes one loop object per render of the
 * loop and rewrites its fields each iteration; its element binding is one
 * slot on the stack. Includes render in the same scope, so a loop variable
 * stays in reach through them, and the depth cap stops a cycle. Pieces are
 * collected in an array and joined once per page: appending strings with +=
 * builds deep rope trees that the collector and the final stringify then
 * have to flatten, and the join is far cheaper than that flattening.
 */
export function renderNodes(nodes, root, templates, depth, out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const k = n[0];
    if (k === 0) {
      out.push(n[1]);
      continue;
    }
    if (k === 1) {
      out.push(escapeHtml(textOf(lookupPath(root, n[1]))));
      continue;
    }
    if (k === 2) {
      out.push(textOf(lookupPath(root, n[1])));
      continue;
    }
    if (k === 3) {
      const branch = truthy(lookupPath(root, n[2])) !== n[1] ? n[3] : n[4];
      if (branch !== null) renderNodes(branch, root, templates, depth, out);
      continue;
    }
    if (k === 4) {
      const xs = lookupPath(root, n[2]);
      if (Array.isArray(xs) && xs.length > 0) {
        const lp = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const at = BIND.length;
        BIND.push(n[1], xs[0], 'loop', lp);
        for (let j = 0; j < xs.length; j++) {
          BIND[at + 1] = xs[j];
          lp.index = j + 1;
          lp.first = j === 0;
          lp.last = j === xs.length - 1;
          renderNodes(n[3], root, templates, depth, out);
        }
        BIND.length = at;
      }
      continue;
    }
    // v6: a constant partial at the top level with no loop bindings renders
    // the same string for every page, so it is rendered once per case and
    // reused. The cached render runs at depth 1, exactly the depth the
    // original include (depth 0 + 1) would have had.
    if (depth === 0 && BIND.length === 0 && CACHEABLE !== null && CACHEABLE.has(n[1])) {
      let s = PARTIAL_CACHE.get(n[1]);
      if (s === undefined) {
        s = renderNodes(templates.get(n[1]), root, templates, 1, []).join('');
        PARTIAL_CACHE.set(n[1], s);
      }
      out.push(s);
      continue;
    }
    const t = templates.get(n[1]);
    if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, root, templates, depth + 1, out);
  }
  return out;
}

/**
 * `name` rendered in `root`: the tree walk over its parsed nodes, joined
 * once, or null when the template is missing. Nothing is compiled: with the
 * optimising compiler off, a generated function per template costs more to
 * build and baseline-compile than the walk it replaces.
 */
function renderTemplate(name, root, templates) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  return renderNodes(nodes, root, templates, 0, []).join('');
}

/** Per-case constant-partial cache: partials whose output depends only on
 * the case-constant roots (site, tags, recent) are rendered once per case.
 * All four render roots share the same site/tags/recent objects, so a
 * cached partial's output is identical whichever root renders it first. */
let CACHEABLE = null;
let PARTIAL_CACHE = null;
const CONST_ROOTS = new Set(['site', 'tags', 'recent']);

/** Free first-segments read by `nodes` (loop-bound names excluded), or null
 * if the analysis budget is exceeded. Includes are followed in the same
 * scope, to the depth cap, exactly as rendering follows them. */
function freeVars(nodes, templates, budget) {
  const free = new Set();
  const walk = (ns, bnd, d) => {
    for (const n of ns) {
      if (--budget.n < 0) return false;
      const k = n[0];
      if (k === 0) continue;
      if (k === 1 || k === 2) {
        if (!bnd.has(n[1][0])) free.add(n[1][0]);
        continue;
      }
      if (k === 3) {
        if (!bnd.has(n[2][0])) free.add(n[2][0]);
        if (!walk(n[3], bnd, d)) return false;
        if (n[4] !== null && !walk(n[4], bnd, d)) return false;
        continue;
      }
      if (k === 4) {
        if (!bnd.has(n[2][0])) free.add(n[2][0]);
        const b2 = new Set(bnd);
        b2.add(n[1]);
        b2.add('loop');
        if (!walk(n[3], b2, d)) return false;
        continue;
      }
      if (d >= INCLUDE_DEPTH) continue;
      const t = templates.get(n[1]);
      if (t !== undefined && !walk(t, bnd, d + 1)) return false;
    }
    return true;
  };
  return walk(nodes, new Set(), 0) ? free : null;
}

// ---------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `t` opens with a scheme (`https:`, `mailto:` ...): a letter, then letters, digits, +, - or ., then ':'. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** A source's tags as [name, slug] pairs, each slug once, in its own order (the first spelling kept). */
function ownTagPairs(s) {
  const seen = [];
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name);
    if (!seen.includes(slug)) {
      seen.push(slug);
      out.push([name, slug]);
    }
  }
  return out;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. The word count was taken once, in the Markdown pass. */
function makeCard(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it: its card, and slug, content, toc, neighbours and is_post. */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer ? s.newer.linkRec : null,
    older: s.older ? s.older.linkRec : null,
    is_post: s.post,
  };
}

/**
 * One site's output tree: path -> text. The pipeline runs in makefun-site's
 * order — sources, front matter, permalinks, Markdown, collections, tags,
 * layouts, report — with each step written to do the same work for less.
 */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // v6: work out which partials are constant for this case (free variables
  // only site/tags/recent) and reset the per-case render cache.
  CACHEABLE = new Set();
  PARTIAL_CACHE = new Map();
  for (const [tname, tnodes] of templates) {
    const fv = freeVars(tnodes, templates, { n: 20000 });
    if (fv !== null && [...fv].every((v) => CONST_ROOTS.has(v))) CACHEABLE.add(tname);
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target)) return target;
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const hit = bySource.get(path);
          if (hit !== undefined) return `${hit.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(md.words / 200));
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.linkRec = linkOf(p);
  });

  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTagPairs(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTagPairs(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const cards = new Map();
  for (const p of posts) cards.set(p, makeCard(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // The four render roots, built once per site: each holds exactly the keys
  // its renders read, and the varying key is reassigned per render.
  const bareRoot = Object.create(null);
  bareRoot.site = site;
  bareRoot.tags = allTags;
  bareRoot.recent = recent;
  const pageRoot = Object.create(null);
  pageRoot.site = site;
  pageRoot.tags = allTags;
  pageRoot.recent = recent;
  pageRoot.page = null;
  const indexRoot = Object.create(null);
  indexRoot.site = site;
  indexRoot.tags = allTags;
  indexRoot.recent = recent;
  indexRoot.posts = null;
  indexRoot.pager = null;
  const tagRoot = Object.create(null);
  tagRoot.site = site;
  tagRoot.tags = allTags;
  tagRoot.recent = recent;
  tagRoot.tag = null;
  for (const s of kept) {
    pageRoot.page = pageOf(s, s.post ? cards.get(s) : makeCard(s));
    output[`${s.outDir}/index.html`] = renderTemplate(s.layout, pageRoot, templates);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  if (templates.has('index')) {
    for (let k = 1; k <= pages; k++) {
      indexRoot.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
      indexRoot.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = renderTemplate('index', indexRoot, templates);
    }
  }
  if (templates.has('tag')) {
    for (const t of tags) {
      tagRoot.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      output[`tags/${t.slug}/index.html`] = renderTemplate('tag', tagRoot, templates);
    }
  }
  if (templates.has('tags')) output['tags/index.html'] = renderTemplate('tags', bareRoot, templates);
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(cmp);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
