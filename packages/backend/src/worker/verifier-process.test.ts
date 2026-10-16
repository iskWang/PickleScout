import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { JobState } from '../types';

vi.mock('../redis', () => ({ updateJobStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./sse', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./generator', () => ({ buildOpenAIClient: vi.fn(), stripMarkdownJson: vi.fn() }));
import { runVerifier } from './verifier';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(tool?: string, source = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-npm-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'verifier-fixture', version: '1.0.0' }));
  if (tool) {
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', tool), '#!/usr/bin/env node\n' + source, { mode: 0o755 });
  }
  return dir;
}

function state(mode: 'smoke' | 'syntax-only' = 'smoke'): JobState {
  return { hash: 'npm-process-test', options: { verificationMode: mode } } as JobState;
}

async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const value = await fs.readFile(file, 'utf8').catch(() => '');
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Child did not start');
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('verifier npm process boundary', () => {
  it.each(['smoke', 'syntax-only'] as const)('runs the local %s tool on Node in the artifact directory', async mode => {
    const dir = await fixture(mode === 'smoke' ? 'cucumber-js' : 'tsc', `
      require('fs').writeFileSync('invocation.json', JSON.stringify({
        cwd: process.cwd(), args: process.argv.slice(2), bun: !!process.versions.bun
      }));
    `);
    expect((await runVerifier(state(mode), dir)).passed).toBe(true);
    const invocation = JSON.parse(await fs.readFile(path.join(dir, 'invocation.json'), 'utf8'));
    expect(await fs.realpath(invocation.cwd)).toBe(await fs.realpath(dir));
    expect(invocation.bun).toBe(false);
    expect(invocation.args).toContain(mode === 'smoke' ? 'progress' : '--noEmit');
  });

  it('fails on a missing local tool instead of fetching it', async () => {
    const dir = await fixture('unrelated');
    await expect(runVerifier(state(), dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.join(dir, 'node_modules', '.bin'))).toEqual(['unrelated']);
  });

  it('installs with lifecycle scripts disabled', async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'ignore-scripts-fixture', version: '1.0.0',
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('unsafe-hook', 'ran')\"" },
    }));
    await expect(runVerifier(state(), dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(dir, 'package-lock.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'unsafe-hook'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('abort terminates npm, its tool and a SIGTERM-resistant descendant', async () => {
    const dir = await fixture('cucumber-js', `
      const child = require('child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); require('fs').writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000)"
      ], { stdio: 'inherit' });
      require('fs').writeFileSync('tool.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const result = runVerifier(state(), dir, controller.signal);
    // Attach the rejection assertion before aborting to avoid an unhandled rejection.
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const descendant = Number(await waitForFile(path.join(dir, 'descendant.pid')));
    const tool = Number(await waitForFile(path.join(dir, 'tool.pid')));
    try {
      controller.abort();
      await rejected;
      for (let i = 0; i < 100 && (running(descendant) || running(tool)); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(running(tool)).toBe(false);
      expect(running(descendant)).toBe(false);
    } finally {
      for (const pid of [tool, descendant]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already terminated. */ }
      }
    }
  }, 10_000);
});
