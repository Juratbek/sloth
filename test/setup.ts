import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs before any server module loads, in every test process: a throwaway home, so `~/.sloth`,
// `~/.claude.json` and the transcripts of the machine this runs on are never read or written, and no
// dry-run flag inherited from the shell leaks in. `test/harness.ts` writes the config under it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-test-'));
process.env.HOME = root;
process.env.SLOTH_CONFIG = path.join(root, 'config.json');
process.env.SLOTH_DRY_RUN = '';
process.env.SLOTH_PORT = '0';
process.env.SLOTH_TEST_ROOT = root;
