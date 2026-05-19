/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');
const COMMON_FIXTURE = path.join(FIXTURES_DIR, 'pass2-common-steps.json');
const FEATURE_FIXTURE = path.join(FIXTURES_DIR, 'pass2-feature-steps.json');

const fixturesExist = existsSync(COMMON_FIXTURE) && existsSync(FEATURE_FIXTURE);

const DOM_API_PATTERN = /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bHTMLInputElement\b|\blocalStorage\b|\bsessionStorage\b|\bnavigator\./;

describe.skipIf(!fixturesExist)('LLM fixture compliance — Pass 2 (run record-llm-fixtures.ts first)', () => {
  let allFiles: Array<{ filename: string; content: string }> = [];

  beforeAll(() => {
    const pass2Common = JSON.parse(require('fs').readFileSync(COMMON_FIXTURE, 'utf-8'));
    const pass2Feature = JSON.parse(require('fs').readFileSync(FEATURE_FIXTURE, 'utf-8'));
    allFiles = [...pass2Common.files, ...pass2Feature.files];
  });

  it('fixture files are valid JSON with a files array', () => {
    const pass2Common = JSON.parse(require('fs').readFileSync(COMMON_FIXTURE, 'utf-8'));
    const pass2Feature = JSON.parse(require('fs').readFileSync(FEATURE_FIXTURE, 'utf-8'));
    expect(Array.isArray(pass2Common.files)).toBe(true);
    expect(Array.isArray(pass2Feature.files)).toBe(true);
  });

  it('no file uses DOM APIs', () => {
    for (const f of allFiles) {
      expect(DOM_API_PATTERN.test(f.content), `${f.filename} contains DOM API`).toBe(false);
    }
  });

  it('every Then step has at least one expect()', () => {
    for (const f of allFiles) {
      const thenBlocks = f.content.match(/Then\([^)]+,\s*async[^}]+\}/gs) ?? [];
      for (const block of thenBlocks) {
        expect(block, `${f.filename}: Then block missing expect()`).toContain('expect(');
      }
    }
  });

  it('every file imports from @cucumber/cucumber', () => {
    for (const f of allFiles) {
      expect(f.content, `${f.filename}`).toContain('@cucumber/cucumber');
    }
  });

  it('every file uses Playwright page API (world.page or const { page })', () => {
    for (const f of allFiles) {
      const hasPageAccess = f.content.includes('world.page') || f.content.includes('const { page }');
      expect(hasPageAccess, `${f.filename}: no world.page access`).toBe(true);
    }
  });
});
