import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureScreenshotStorageDir } from './startup';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ensureScreenshotStorageDir', () => {
  it('creates the static root before screenshot routes are registered', async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-storage-'));
    tempDirs.push(storageDir);
    const screenshotsDir = path.join(storageDir, 'screenshots');

    await fs.rm(storageDir, { recursive: true, force: true });
    await ensureScreenshotStorageDir(storageDir);

    const stat = await fs.stat(screenshotsDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
