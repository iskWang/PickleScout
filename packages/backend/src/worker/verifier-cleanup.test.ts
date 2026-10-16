import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import type { JobState } from '../types';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
}));
vi.mock('../redis', () => ({ updateJobStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./sse', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./generator', () => ({ buildOpenAIClient: vi.fn(), stripMarkdownJson: vi.fn() }));
import { runVerifier } from './verifier';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('verifier cleanup failures', () => {
  it.each(['exit', 'error'] as const)('does not throw from the %s listener when group cleanup is denied', async event => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-cleanup-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'tsc'), '');
    const child = Object.assign(new ChildProcess(), {
      pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('secret raw process diagnostic'), { code: 'EPERM' });
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { hash: 'cleanup-test', options: { verificationMode: 'syntax-only' } } as JobState;
    const result = runVerifier(state, dir);
    const failure = new Error('spawn failed');
    const settled = event === 'error'
      ? expect(result).rejects.toBe(failure)
      : expect(result).resolves.toMatchObject({ passed: true });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(() => child.emit(event, event === 'error' ? failure : 0)).not.toThrow();
    child.emit('close', 0);
    await settled;
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(warning).toHaveBeenCalledWith('Verifier process-group cleanup failed; child processes may remain.');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
  });
});
