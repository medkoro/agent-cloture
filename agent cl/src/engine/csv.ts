import { readFile } from 'node:fs/promises';

export async function readCsv(path: string): Promise<Record<string, string>[]> {
  const content = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!content) return [];
  const [header, ...rows] = content.split(/\r?\n/);
  const columns = parseCsvLine(header);
  return rows.filter(Boolean).map((row) => {
    const cells = parseCsvLine(row);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? '']));
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  result.push(cell);
  return result;
}
