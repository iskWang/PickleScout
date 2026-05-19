import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

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
