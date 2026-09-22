// Analyse structurelle minimale de PDF (sans dépendance externe) : décode les flux de
// contenu (ASCII85Decode / ASCIIHexDecode / FlateDecode) et interprète les opérateurs de
// dessin de texte pour reconstruire, pour chaque fragment de texte, sa taille de police, sa
// couleur de remplissage et sa position sur la page. Ceci permet de distinguer du texte
// réellement affiché d'un texte rendu invisible par une ruse CSS/police (taille quasi nulle,
// couleur blanche, position hors des limites de la page) — aucune donnée du dossier n'est en
// dur ici, uniquement une grammaire PDF générique appliquée aux octets reçus en paramètre.
import { inflateSync } from 'node:zlib';

export interface TextRun {
  text: string;
  fontSize: number;
  color: [number, number, number];
  x: number;
  y: number;
}

export interface PdfAnalysis {
  visibleText: string;
  hiddenText: string;
  allText: string;
  suspiciousRuns: TextRun[];
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function ascii85Decode(data: string): Buffer {
  let str = data.replace(/\s+/g, '');
  if (str.endsWith('~>')) str = str.slice(0, -2);
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of str) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
      group = [];
    }
  }
  if (group.length > 0) {
    const consumed = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, consumed - 1));
  }
  return Buffer.from(out);
}

function asciiHexDecode(data: string): Buffer {
  const hex = data.replace(/\s+/g, '').replace(/>$/, '');
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
}

function decodeStream(raw: Buffer, filters: string[]): Buffer {
  let data = raw;
  for (const filter of filters) {
    if (filter === 'ASCII85Decode') data = ascii85Decode(data.toString('latin1'));
    else if (filter === 'ASCIIHexDecode') data = asciiHexDecode(data.toString('latin1'));
    else if (filter === 'FlateDecode') data = inflateSync(data);
  }
  return data;
}

function extractFilters(dict: string): string[] {
  const match = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  if (!match) return [];
  return [...match[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
}

function objectBodies(text: string): Map<number, string> {
  const bodies = new Map<number, string>();
  for (const match of text.matchAll(/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g)) {
    bodies.set(Number(match[1]), match[2]);
  }
  return bodies;
}

function refs(dict: string, key: string): number[] {
  const single = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  if (single) return [Number(single[1])];
  const array = dict.match(new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`));
  if (array) return [...array[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
  return [];
}

function contentStreamsForPage(buffer: Buffer, text: string, bodies: Map<number, string>, pageBody: string): Buffer[] {
  const streams: Buffer[] = [];
  for (const contentsRef of refs(pageBody, 'Contents')) {
    const body = bodies.get(contentsRef);
    if (!body) continue;
    const streamStart = body.indexOf('stream');
    if (streamStart < 0) continue;
    const objectIndex = text.indexOf(`${contentsRef} 0 obj`);
    if (objectIndex < 0) continue;
    let start = text.indexOf('stream', objectIndex) + 'stream'.length;
    while (text[start] === '\r' || text[start] === '\n') start += 1;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    const filters = extractFilters(body.slice(0, streamStart));
    const raw = buffer.subarray(start, end);
    try {
      streams.push(decodeStream(raw, filters));
    } catch {
      // Flux illisible (filtre non supporté) : ignoré plutôt qu'une hypothèse inventée.
    }
  }
  return streams;
}

function mediaBoxOf(pageBody: string, bodies: Map<number, string>): [number, number, number, number] {
  const direct = pageBody.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
  if (direct) return [Number(direct[1]), Number(direct[2]), Number(direct[3]), Number(direct[4])];
  for (const body of bodies.values()) {
    const match = body.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return [0, 0, 612, 792];
}

function decodePdfString(literal: string): string {
  let out = '';
  for (let i = 0; i < literal.length; i += 1) {
    const ch = literal[i];
    if (ch === '\\') {
      const next = literal[i + 1];
      if (next === 'n') { out += '\n'; i += 1; }
      else if (next === 'r') { out += '\r'; i += 1; }
      else if (next === 't') { out += '\t'; i += 1; }
      else if (next === '(' || next === ')' || next === '\\') { out += next; i += 1; }
      else if (next >= '0' && next <= '7') {
        const octal = literal.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? '';
        out += String.fromCharCode(parseInt(octal, 8));
        i += octal.length;
      } else { out += next ?? ''; i += 1; }
    } else {
      out += ch;
    }
  }
  return out;
}

function tokenize(content: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '%') { while (i < content.length && content[i] !== '\n') i += 1; continue; }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      let literal = '';
      while (j < content.length && depth > 0) {
        if (content[j] === '\\') { literal += content[j] + (content[j + 1] ?? ''); j += 2; continue; }
        if (content[j] === '(') depth += 1;
        if (content[j] === ')') { depth -= 1; if (depth === 0) break; }
        literal += content[j];
        j += 1;
      }
      tokens.push(`(${literal})`);
      i = j + 1;
      continue;
    }
    if (ch === '[' || ch === ']' || ch === '<' || ch === '>') { tokens.push(ch); i += 1; continue; }
    let j = i;
    while (j < content.length && !/[\s()[\]<>]/.test(content[j])) j += 1;
    tokens.push(content.slice(i, j));
    i = j;
  }
  return tokens;
}

function interpret(content: string, pageBox: [number, number, number, number]): TextRun[] {
  const tokens = tokenize(content);
  const runs: TextRun[] = [];
  const ctmStack: Matrix[] = [IDENTITY];
  let ctm = IDENTITY;
  let tm = IDENTITY;
  let fontSize = 0;
  let fillColor: [number, number, number] = [0, 0, 0];
  const operands: string[] = [];

  const num = (s: string): number => Number(s) || 0;
  const pushColor = (rgb: [number, number, number]): void => { fillColor = rgb; };

  const emit = (raw: string): void => {
    const text = decodePdfString(raw);
    if (!text.trim()) return;
    const [x, y] = apply(ctm, tm[4], tm[5]);
    runs.push({ text, fontSize: Math.abs(fontSize * Math.hypot(tm[0], tm[1])), color: fillColor, x, y });
  };

  for (const token of tokens) {
    switch (token) {
      case 'q':
        ctmStack.push(ctm);
        continue;
      case 'Q':
        ctm = ctmStack.pop() ?? IDENTITY;
        operands.length = 0;
        continue;
      case 'cm': {
        const [a, b, c, d, e, f] = operands.slice(-6).map(num);
        ctm = multiply([a, b, c, d, e, f], ctm);
        operands.length = 0;
        continue;
      }
      case 'BT':
        tm = IDENTITY;
        operands.length = 0;
        continue;
      case 'ET':
        operands.length = 0;
        continue;
      case 'Tm': {
        const [a, b, c, d, e, f] = operands.slice(-6).map(num);
        tm = [a, b, c, d, e, f];
        operands.length = 0;
        continue;
      }
      case 'Td':
      case 'TD': {
        const [tx, ty] = operands.slice(-2).map(num);
        tm = multiply([1, 0, 0, 1, tx, ty], tm);
        operands.length = 0;
        continue;
      }
      case 'T*':
        tm = multiply([1, 0, 0, 1, 0, -fontSize], tm);
        operands.length = 0;
        continue;
      case 'Tf': {
        fontSize = num(operands[operands.length - 1] ?? '0');
        operands.length = 0;
        continue;
      }
      case 'rg': {
        const [r, g, b] = operands.slice(-3).map(num);
        pushColor([r, g, b]);
        operands.length = 0;
        continue;
      }
      case 'g': {
        const gray = num(operands[operands.length - 1] ?? '0');
        pushColor([gray, gray, gray]);
        operands.length = 0;
        continue;
      }
      case 'k': {
        const [c, m, y, k] = operands.slice(-4).map(num);
        pushColor([1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)]);
        operands.length = 0;
        continue;
      }
      case 'Tj': {
        const last = operands[operands.length - 1] ?? '';
        if (last.startsWith('(')) emit(last.slice(1, -1));
        operands.length = 0;
        continue;
      }
      case "'":
      case '"': {
        const last = operands[operands.length - 1] ?? '';
        if (last.startsWith('(')) emit(last.slice(1, -1));
        operands.length = 0;
        continue;
      }
      case 'TJ': {
        const joined = operands.join(' ');
        for (const literal of joined.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) emit(literal[1]);
        operands.length = 0;
        continue;
      }
      default:
        operands.push(token);
        if (operands.length > 12) operands.shift();
    }
  }
  return runs;
}

// Une police quasi nulle (<= 2pt, illisible à l'œil nu) est un signal fort à elle seule ;
// le blanc-sur-blanc et le hors-page le sont tout autant. Aucun de ces seuils n'est propre à
// un dossier : ce sont des heuristiques de rendu PDF génériques.
const NEAR_ZERO_FONT_SIZE = 2;

export function isSuspiciousRun(run: TextRun, page: [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = page;
  const isWhite = run.color.every((component) => component >= 0.95);
  const isNearZeroFont = run.fontSize > 0 && run.fontSize <= NEAR_ZERO_FONT_SIZE;
  const isOffPage = run.x < x0 - 1 || run.x > x1 + 1 || run.y < y0 - 1 || run.y > y1 + 1;
  return isWhite || isNearZeroFont || isOffPage;
}

export function analyzePdf(buffer: Buffer): PdfAnalysis {
  const text = buffer.toString('latin1');
  const bodies = objectBodies(text);
  const visible: string[] = [];
  const hidden: string[] = [];
  const suspiciousRuns: TextRun[] = [];

  for (const [, body] of bodies) {
    if (!/\/Type\s*\/Page\b(?!s)/.test(body)) continue;
    const page = mediaBoxOf(body, bodies);
    const streams = contentStreamsForPage(buffer, text, bodies, body);
    for (const stream of streams) {
      const runs = interpret(stream.toString('latin1'), page);
      for (const run of runs) {
        if (isSuspiciousRun(run, page)) {
          suspiciousRuns.push(run);
          hidden.push(run.text);
        } else {
          visible.push(run.text);
        }
      }
    }
  }

  return {
    visibleText: visible.join(' '),
    hiddenText: hidden.join(' '),
    allText: [...visible, ...hidden].join(' '),
    suspiciousRuns,
  };
}
