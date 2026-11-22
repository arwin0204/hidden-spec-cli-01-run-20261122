// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies its edits to the tree in the working directory,
// and writes every change or none. See SPEC.md for the whole contract.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// Layout of the program:
//   - sections 1-2: argument parsing, output and exit codes (run/main)
//   - section 3: files, lines and safe paths (splitFile, joinFile, safePath)
//   - section 4: format detection (detect)
//   - section 5: three-tier line matching (findTier, buildNew)
//   - section 6: unified diffs (parseUnified, applyHunks)
//   - section 7: SEARCH/REPLACE blocks (parseSearchReplace)
//   - section 8: V4A patches (parseV4a, parseUpdateBody)
//   - section 9: JSON edits (jsonEdits, jsonEdit)
//   - section 10: order and atomicity (Tree, run)
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the lines at the bottom): the
// hand-over and runner.ts are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the program prints exactly this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed; the program reports `error: <code> <path>` for it. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A move an edit made, for the `R <old> -> <new>` output line. */
interface Move {
  old: string;
  new: string;
}

/** One parsed edit: apply it to the tree, returning its move, if any. */
type Edit = (tree: Tree) => Move | undefined;

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (section 3): split at `\n`, one trailing `\r` removed, and no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe (section 3) when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of two paths (UTF-8), for the output lines. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file's lines (section 3): its line break, its lines, and whether it ends with a line break. */
function splitFile(text: string): { br: string; lines: string[]; finalBreak: boolean } {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

/** The text of lines with a line break (section 3): a file of no lines is written empty. */
function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqualAt(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier where one is. */
function findAnchorLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEqualAt(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/**
 * The lines N becomes when it replaces O at position `pos` (section 5).
 * `ctx[q]` is the index into O of N's q-th line when that line is a context
 * line (written as the file's own matched line), or -1 otherwise. At tier 2
 * every other line of N is re-indented: P, the leading spaces and tabs of
 * O's first line, is replaced by F, those of the file's first matched line.
 */
function buildNew(fileLines: string[], pos: number, o: string[], n: string[], tier: number, ctx: number[]): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = /^[ \t]*/.exec(o[0]!)![0];
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
  }
  const out: string[] = [];
  for (let q = 0; q < n.length; q++) {
    const c = ctx[q]!;
    if (c >= 0) {
      out.push(fileLines[pos + c]!);
      continue;
    }
    const line = n[q]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: ` ` context, `-` old, `+` new, `\` no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** O (context and `-` lines), N (context and `+` lines) and N's context map, from body lines in order. */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; ctx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: number[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      o.push(bl.text);
      n.push(bl.text);
      ctx.push(o.length - 1);
    } else if (bl.kind === '-') {
      o.push(bl.text);
    } else if (bl.kind === '+') {
      n.push(bl.text);
      ctx.push(-1);
    }
  }
  return { o, n, ctx };
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line A (1-based) of the hunk header. */
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string;
  dashNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, spaces removed, one leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  let p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The first defined of three path sources, with `/dev/null` read as no file. */
function pickPath(a: string | undefined, b: string | undefined, c: string | undefined): string | null | undefined {
  const norm = (v: string | undefined): string | null | undefined => (v === undefined ? undefined : v === '/dev/null' ? null : v);
  const x = norm(a);
  if (x !== undefined) return x;
  const y = norm(b);
  if (y !== undefined) return y;
  return norm(c);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const newSection = (): Section => {
    const s: Section = { newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!(cur !== null && inHeader && cur.dashOld === undefined)) newSection();
      cur!.dashOld = headerPath(lines[i]!);
      cur!.dashNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push({ kind: bl === '' ? ' ' : (bl[0] as ' ' | '-' | '+' | '\\'), text: bl === '' ? '' : bl.slice(1) });
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(hm[1]!), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.dashNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether a `\` line (as in `\ No newline at end of file`) immediately follows the body line at `at`. */
function hasBackslashAfter(body: BodyLine[], at: number): boolean {
  return at + 1 < body.length && body[at + 1]!.kind === '\\';
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNewline(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') last = k;
  }
  return last >= 0 && hasBackslashAfter(h.body, last);
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { br, lines, finalBreak } = splitFile(text);
  let cur = lines;
  let fb = finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctx } = splitBody(h.body);
    const noNl = hunkNoNewline(h);
    if (o.length > 0) {
      const found = findTier(cur, o, strict);
      if (!found) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === cur.length;
      const repl = buildNew(cur, best, o, n, found.tier, ctx);
      cur = [...cur.slice(0, best), ...repl, ...cur.slice(best + o.length)];
      if (atEnd) fb = !noNl;
      d += n.length - o.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = idx === cur.length;
      cur = [...cur.slice(0, idx), ...n, ...cur.slice(idx)];
      if (atEnd) fb = !noNl;
      d += n.length;
    }
  }
  return joinFile(cur, br, fb);
}

/** The text of a created file: the `+` lines of all the section's hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const lines: string[] = [];
  let lastPlus: { h: Hunk; at: number } | null = null;
  for (const h of hunks) {
    h.body.forEach((bl, at) => {
      if (bl.kind === '+') {
        lines.push(bl.text);
        lastPlus = { h, at };
      }
    });
  }
  if (lines.length === 0) return '';
  const noNl = lastPlus !== null && hasBackslashAfter(lastPlus.h.body, lastPlus.at);
  return lines.join('\n') + (noNl ? '' : '\n');
}

/** One unified-diff section as one edit. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = pickPath(sec.dashOld, sec.renameFrom, sec.diffOld);
  const newP = pickPath(sec.dashNew, sec.renameTo, sec.diffNew);
  return (tree) => {
    if (sec.newFile || oldP === null) {
      const p = newP ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, creationText(sec.hunks));
      return undefined;
    }
    if (sec.deletedFile || newP === null) {
      const p = oldP ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.now.set(p, null);
      return undefined;
    }
    const oldPath = oldP ?? '';
    const newPath = newP ?? '';
    if (oldPath !== newPath) {
      if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
      if (!safePath(newPath)) throw new EditFail('unsafe', newPath);
      const text = tree.get(oldPath);
      if (text === null) throw new EditFail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
      const out = applyHunks(text, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      return { old: oldPath, new: newPath };
    }
    if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
    const text = tree.get(oldPath);
    if (text === null) throw new EditFail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(text, sec.hunks, strict, oldPath));
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

/** One SEARCH/REPLACE block as one edit. */
function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safePath(p)) throw new EditFail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return undefined;
    }
    const text = tree.get(p);
    if (text === null) throw new EditFail('missing', p);
    const { br, lines, finalBreak } = splitFile(text);
    const found = findTier(lines, b.oldLines, strict);
    if (!found) throw new EditFail('no-match', p);
    if (found.positions.length > 1) throw new EditFail('ambiguous', p);
    const pos = found.positions[0]!;
    const repl = buildNew(lines, pos, b.oldLines, b.newLines, found.tier, b.newLines.map(() => -1));
    const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile(out, br, finalBreak));
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

type V4aKind = 'add' | 'delete' | 'update';

/** Which section, if any, a line starts, or null. */
function v4aSectionKind(line: string): V4aKind | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

interface Chunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** The `*** Move to:` path and the chunks of an Update File section's body lines. */
function parseUpdateBody(body: string[], baseNo: number, updateNo: number): { moveTo: string | null; chunks: Chunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  while (idx < body.length) {
    const line = body[idx]!;
    const no = baseNo + idx;
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      idx++;
    } else if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      idx++;
    } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+'), text: line === '' ? '' : line.slice(1) });
      idx++;
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
  return { moveTo, chunks };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    const kind = v4aSectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j]!) === null) j++;
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    const baseNo = i + 2;
    if (kind === 'add') {
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (!(bl === '' || bl.startsWith('+'))) throw new Exit2(`error: parse ${baseNo + k}`);
      }
      edits.push(v4aAddEdit(path, body.map((bl) => (bl === '' ? '' : bl.slice(1)))));
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${baseNo}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const { moveTo, chunks } = parseUpdateBody(body, baseNo, i + 1);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

/** One `*** Add File:` section as one edit. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return undefined;
  };
}

/** One `*** Delete File:` section as one edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.now.set(path, null);
    return undefined;
  };
}

/** One `*** Update File:` section as one edit. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const { br, lines, finalBreak } = splitFile(text);
    let cur = lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchorLine(cur, ch.anchor, cursor, strict);
        if (at === null) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const { o, n, ctx } = splitBody(ch.body);
      if (o.length === 0) {
        const idx = ch.eof ? cur.length : cursor;
        cur = [...cur.slice(0, idx), ...n, ...cur.slice(idx)];
        cursor = idx + n.length;
      } else {
        const found = findTierEof(cur, o, strict, cursor, ch.eof);
        if (!found) throw new EditFail('no-match', path);
        const pos = found.positions[0]!;
        const repl = buildNew(cur, pos, o, n, found.tier, ctx);
        cur = [...cur.slice(0, pos), ...repl, ...cur.slice(pos + o.length)];
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(cur, br, finalBreak);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return { old: path, new: moveTo };
    }
    tree.now.set(path, out);
    return undefined;
  };
}

/** Like findTier, but from a cursor, and for an end-of-file chunk only occurrences ending at the file's last line count. */
function findTierEof(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let positions = occurrences(lines, o, t, from);
    if (eof) positions = positions.filter((p) => p + o.length === lines.length);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
      return undefined;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return undefined;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const { br, lines, finalBreak } = splitFile(before);
      if (line < 0 || line > lines.length) throw new EditFail('no-match', p);
      const out = [...lines.slice(0, line), ...add, ...lines.slice(line)];
      tree.now.set(p, joinFile(out, br, finalBreak));
      return undefined;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

interface Row {
  /** The path the row sorts by: its own path, or `<new>` for a move. */
  key: string;
  line: string;
  kind: 'A' | 'D' | 'M' | 'R';
  path: string;
}

function run(args: string[]): { code: number; out: string[] } {
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    const row: Row = { key: p, line: `${kind} ${p}`, kind, path: p };
    rows.push(row);
    byPath.set(p, row);
  }
  for (const mv of moves) {
    const dRow = byPath.get(mv.old);
    const aRow = byPath.get(mv.new);
    if (dRow !== undefined && dRow.kind === 'D' && aRow !== undefined && aRow.kind === 'A') {
      rows.splice(rows.indexOf(dRow), 1);
      rows.splice(rows.indexOf(aRow), 1);
      byPath.delete(mv.old);
      byPath.delete(mv.new);
      const rRow: Row = { key: mv.new, line: `R ${mv.old} -> ${mv.new}`, kind: 'R', path: mv.new };
      rows.push(rRow);
      byPath.set(mv.new, rRow);
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));

  if (!check) {
    const changed = [...tree.now.entries()].filter(([p, v]) => tree.original(p) !== v);
    for (const [p] of changed.filter(([, v]) => v === null)) {
      try {
        rmSync(p, { force: true });
      } catch {
        // A path that cannot be removed is left as it is; the row still stands.
      }
    }
    for (const [p, v] of changed.filter(([, v]) => v !== null) as [string, string][]) {
      try {
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
      } catch {
        // Not an existing directory: nothing to clear first.
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
