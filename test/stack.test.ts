import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectStack, installSteps, manualCommand, requiredStack } from '../server/stack';
import { configure, root } from './harness';

vi.mock('node:child_process', () => import('./child-process-mock'));

const write = (rel: string, text = '') => {
  const file = path.join(root(), 'runner', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  fs.rmSync(path.join(root(), 'runner'), { recursive: true, force: true });
  configure();
});

describe('detectStack', () => {
  it('reads runtimes off marker files and services off the manifests, at the root and one level down', () => {
    write('package.json', '{"dependencies":{"react":"19"}}');
    write('apps/api/.env.example', 'DATABASE_URL=postgresql://localhost/app\nREDIS_URL=redis://localhost:6379');
    write('packages/worker/pyproject.toml', '[project]');
    expect(detectStack(path.join(root(), 'runner'))).toEqual(['postgresql', 'redis', 'node', 'python']);
  });
  it('finds nothing in an empty or absent checkout', () => {
    expect(detectStack(path.join(root(), 'runner'))).toEqual([]);
    expect(detectStack(path.join(root(), 'nowhere'))).toEqual([]);
  });
  it('is what `auto` means; a saved list wins over the checkout', () => {
    write('pom.xml', '<project/>');
    expect(requiredStack('auto')).toEqual(['java']);
    expect(requiredStack(['redis'])).toEqual(['redis']);
    configure({ stack: ['postgresql'] });
    expect(requiredStack()).toEqual(['postgresql']);
  });
});

describe('installSteps', () => {
  it('installs, links and starts PostgreSQL with Homebrew', () => {
    const steps = installSteps('postgresql', { kind: 'brew' });
    expect(steps.map((s) => [s.cmd, ...s.args].join(' '))).toEqual([
      'brew install postgresql@17',
      'brew link --force --overwrite postgresql@17',
      'brew services start postgresql@17',
    ]);
    expect(steps[1].optional).toBe(true);
  });
  it('goes through sudo -n for apt and makes the current user a PostgreSQL superuser', () => {
    const steps = installSteps('postgresql', { kind: 'apt', sudo: true });
    expect(steps[0]).toEqual({ cmd: 'sudo', args: ['-n', 'apt-get', 'update', '-q'] });
    expect(steps[1].args).toEqual(['-n', 'apt-get', 'install', '-y', '-q', 'postgresql']);
    expect(steps.at(-1)?.args.slice(0, 5)).toEqual(['-n', '-u', 'postgres', 'createuser', '-s']);
    expect(installSteps('redis', { kind: 'apt', sudo: false })[1]).toEqual({ cmd: 'apt-get', args: ['install', '-y', '-q', 'redis-server'] });
  });
  it('has nothing to run without a package manager, and names the command for a human', () => {
    expect(installSteps('java', { kind: 'none', error: 'x' })).toEqual([]);
    expect(manualCommand('redis')).toMatch(/brew install redis|apt-get install -y redis-server/);
  });
});
