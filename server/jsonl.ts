import fs from 'node:fs';

/** Transcript records are free-form JSON; each reader picks out the fields it knows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = any;
/** How many transcripts keep their parsed records in memory — the ones open in the UI, not the whole month. */
export const HOT = 4;

/**
 * The records appended to a .jsonl since `offset` — complete lines only, so a line still being written
 * is read next time — and where the next read starts. Every reader of transcripts goes through this and
 * keeps only what it needs: the sessions list and the usage page fold each file into a small digest as
 * it grows (`digestFile`), and only a transcript open in the UI keeps its records (`readRecords`).
 */
export function readNew(file: string, offset: number): { records: Rec[]; offset: number } {
  const size = fs.statSync(file).size;
  if (size < offset) offset = 0; // truncated or replaced: start over
  if (size === offset) return { records: [], offset };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { records: [], offset };
    const records: Rec[] = [];
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* corrupt line */
      }
    }
    return { records, offset: offset + Buffer.byteLength(text.slice(0, end + 1), 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

const hot = new Map<string, { offset: number; records: Rec[] }>();

/** A transcript's records, parsed incrementally and kept for the `HOT` most recently asked-for files only. */
export function readRecords(file: string): Rec[] {
  let c = hot.get(file);
  if (!c) hot.set(file, (c = { offset: 0, records: [] }));
  const { records, offset } = readNew(file, c.offset);
  if (offset < c.offset) c.records.length = 0;
  c.records.push(...records);
  c.offset = offset;
  // Most recently used last; the oldest beyond HOT are let go.
  hot.delete(file);
  hot.set(file, c);
  for (const key of hot.keys()) {
    if (hot.size <= HOT) break;
    hot.delete(key);
  }
  return c.records;
}
/** The files whose records are in memory right now — for tests. */
export const hotFiles = () => [...hot.keys()];
export const forgetHot = (file: string) => hot.delete(file);

