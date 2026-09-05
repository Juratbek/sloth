import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { STACK, type StackChoice, type StackId } from './config-types';

/**
 * The stack table and what a checkout looks like it needs. `stack.ts` does the checking and the
 * installing; this file is what both it and the sessions' environment read.
 */

interface Tool {
  label: string;
  /** The executable whose presence means "installed". */
  command: string;
  version: string[];
  brew: { formula: string; link?: boolean; service?: string };
  apt: { packages: string[]; service?: string };
  /** Files whose presence in the checkout means the project uses this. */
  markers?: string[];
  /** A word that, in one of the manifests (`MANIFESTS`), means the project uses this. */
  pattern?: RegExp;
}

export const TOOLS: Record<StackId, Tool> = {
  postgresql: {
    label: 'PostgreSQL',
    command: 'psql',
    version: ['--version'],
    brew: { formula: 'postgresql@17', link: true, service: 'postgresql@17' },
    apt: { packages: ['postgresql'], service: 'postgresql' },
    pattern: /postgres|\bpg\b|psycopg|asyncpg/i,
  },
  redis: {
    label: 'Redis',
    command: 'redis-server',
    version: ['--version'],
    brew: { formula: 'redis' },
    apt: { packages: ['redis-server'], service: 'redis-server' },
    pattern: /redis|bullmq/i,
  },
  node: {
    label: 'Node.js',
    command: 'node',
    version: ['--version'],
    brew: { formula: 'node' },
    apt: { packages: ['nodejs', 'npm'] },
    markers: ['package.json'],
  },
  python: {
    label: 'Python',
    command: 'python3',
    version: ['--version'],
    brew: { formula: 'python' },
    apt: { packages: ['python3', 'python3-pip', 'python3-venv'] },
    markers: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'],
  },
  java: {
    label: 'Java',
    command: 'java',
    version: ['--version'],
    brew: { formula: 'openjdk', link: true },
    apt: { packages: ['default-jdk'] },
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  },
};

/** The files a project describes its services in — read at the root and one level down in a monorepo. */
const MANIFESTS = [
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  '.env.example', '.env.sample', '.env.template',
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'README.md', 'CLAUDE.md',
];
const WORKSPACES = ['apps', 'packages', 'services'];
const MAX_MANIFEST = 512 * 1024;

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The checkout's root and, for a monorepo, each workspace one level down. */
function dirsOf(root: string): string[] {
  if (!isDir(root)) return [];
  const dirs = [root];
  for (const ws of WORKSPACES) {
    const base = path.join(root, ws);
    if (!isDir(base)) continue;
    for (const name of fs.readdirSync(base)) if (isDir(path.join(base, name))) dirs.push(path.join(base, name));
  }
  return dirs;
}

/** What the checkout at `root` looks like it needs: marker files, or a manifest that names the service. */
export function detectStack(root: string): StackId[] {
  const dirs = dirsOf(root);
  if (!dirs.length) return [];
  let manifests: string | undefined;
  const text = () => {
    if (manifests !== undefined) return manifests;
    const parts: string[] = [];
    for (const dir of dirs)
      for (const name of MANIFESTS) {
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).size <= MAX_MANIFEST) parts.push(fs.readFileSync(file, 'utf8'));
        } catch {
          /* not here */
        }
      }
    return (manifests = parts.join('\n'));
  };
  return STACK.filter((id) => {
    const t = TOOLS[id];
    if (t.markers?.some((m) => dirs.some((d) => fs.existsSync(path.join(d, m))))) return true;
    return !!t.pattern && t.pattern.test(text());
  });
}

/** The stack this configuration wants: the saved list, or what the checkout shows when it says `auto`. */
export const requiredStack = (choice: StackChoice = cfg().stack, root = cfg().runnerRoot): StackId[] =>
  choice === 'auto' ? detectStack(root) : choice;
