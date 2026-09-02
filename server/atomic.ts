import fs from 'node:fs';
import path from 'node:path';

/**
 * A file replaced in one step, never half-written. Sloth's own memory is a tree of small files — the
 * config, `state.json`, the dedupe markers, `preview-state.json`, which run holds which worktree slot —
 * and it reads all of them back on the next tick and after every restart. `writeFileSync` truncates
 * first and writes after, so a kill, a full disk or a machine losing power between the two leaves a file
 * that exists and says nothing: a config that will not parse, a preview whose key is gone, a run whose
 * state reads as `working` for ever. `rename` within one directory is atomic on every filesystem Sloth
 * runs on, so a reader sees either the whole old file or the whole new one — the same move `retention.ts`
 * already rotates `watcher.log` with.
 *
 * It lives on its own, with nothing but `node:fs` behind it, so the configuration layer can use it too:
 * `runner/log.ts` reaches for `cfg()`, and `config-file.ts` importing that would be a cycle.
 */
export function writeAtomic(file: string, body: string, options?: fs.WriteFileOptions): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Beside the file, so the rename stays within one filesystem — across one it is a copy, and not atomic.
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, body, options);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
