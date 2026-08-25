import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'os';
import { inflateRawSync } from 'zlib';

vi.mock('../redis', () => ({
  appendSseEvent: vi.fn().mockResolvedValue(undefined),
  getSsePublisher: () => ({ publish: vi.fn().mockResolvedValue(undefined) }),
  sseChannelForJob: (hash: string) => `events:${hash}`,
}));

import type { JobState } from '../types';

function readZipEntry(zipPath: string, entryName: string): string {
  const zip = readFileSync(zipPath);
  const name = Buffer.from(entryName);
  for (let offset = 0; offset <= zip.length - 46 - name.length; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    if (!zip.subarray(offset + 46, offset + 46 + nameLength).equals(name)) {
      offset += 45 + nameLength + extraLength + commentLength;
      continue;
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const localOffset = zip.readUInt32LE(offset + 42);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8');
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}
// All templates the packager loads at runtime (packager.ts readTemplate calls)
const PACKAGER_TEMPLATES = [
  'cucumber.js',
  'world.ts',
  'hooks.ts',
  'playwright.config.ts',
  'github-workflow.yml',
  'env.example',
] as const;

const TEMPLATES_DIR = join(__dirname, '../templates');
const cucumberTemplate = readFileSync(join(TEMPLATES_DIR, 'cucumber.js.template'), 'utf-8');
const hooksTemplate = readFileSync(join(TEMPLATES_DIR, 'hooks.ts.template'), 'utf-8');

describe("packager template files — all required templates exist (ENOENT guard)", () => {
  for (const name of PACKAGER_TEMPLATES) {
    it(`${name}.template is readable at the path packager uses`, () => {
      const templatePath = join(TEMPLATES_DIR, `${name}.template`);
      expect(existsSync(templatePath), `Missing: ${templatePath}`).toBe(true);
      const content = readFileSync(templatePath, 'utf-8');
      expect(content.length, `${name}.template is empty`).toBeGreaterThan(0);
    });
  }
});

describe("cucumber.js.template — formatter (ISC-39/40)", () => {
  it("contains 'progress' as a format entry", () => {
    expect(cucumberTemplate).toContain("'progress'");
  });
  it("does NOT contain 'progress-bar'", () => {
    expect(cucumberTemplate).not.toContain("'progress-bar'");
  });
  it("does NOT set timeout in config (not a valid Cucumber IConfiguration key — use setDefaultTimeout in hooks)", () => {
    expect(cucumberTemplate).not.toMatch(/timeout:\s*\d/);
  });
});

describe("hooks.ts.template — Playwright API validity (ISC-46–49)", () => {
  it("does NOT pass actionTimeout to newContext() (TS2353 — not in BrowserContextOptions)", () => {
    expect(hooksTemplate).not.toMatch(/newContext\s*\([^)]*actionTimeout/s);
  });
  it("does NOT pass navigationTimeout to newContext() (TS2353 — not in BrowserContextOptions)", () => {
    expect(hooksTemplate).not.toMatch(/newContext\s*\([^)]*navigationTimeout/s);
  });
  it("calls setDefaultTimeout() from @cucumber/cucumber at >= 60000ms to override 5s default", () => {
    const match = hooksTemplate.match(/setDefaultTimeout\(([\d_]+)\)/);
    expect(match, 'setDefaultTimeout missing from hooks.ts template').toBeTruthy();
    const value = parseInt(match![1].replace(/_/g, ''), 10);
    expect(value).toBeGreaterThanOrEqual(60000);
  });
  it("calls context.setDefaultTimeout() as a method", () => {
    expect(hooksTemplate).toContain('.setDefaultTimeout(');
  });
  it("calls context.setDefaultNavigationTimeout() as a method with >= 60000ms", () => {
    const match = hooksTemplate.match(/\.setDefaultNavigationTimeout\((\d+)\)/);
    expect(match, 'setDefaultNavigationTimeout missing').toBeTruthy();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(60000);
  });
});
describe('generated workflow installation', () => {
  it('uses a non-frozen install so zips without a lockfile can install', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'picklescout-packager-'));
    const previousStorage = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = storage;
    try {
      const { runPackager } = await import('./packager');
      const zipPath = await runPackager(
        {
          hash: 'workflow-test',
          llm: { provider: 'test', model: 'test' },
          tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
        } as unknown as JobState,
        {
          featureFiles: [{ filename: 'sample.feature', content: 'Feature: sample\n  Scenario: works\n' }],
          stepFiles: [{ filename: 'steps.ts', content: 'export {};\n' }],
        },
        { jobHash: 'workflow-test', targetUrl: 'https://example.test', entries: [], inferredJourneys: [] },
        true,
        0,
      );
      expect(readZipEntry(zipPath, '.github/workflows/e2e.yml')).toContain('pnpm install --no-frozen-lockfile');
    } finally {
      if (previousStorage === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previousStorage;
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
