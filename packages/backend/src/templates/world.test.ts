import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as ts from 'typescript';
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';

// The template is a standalone file dropped into a generated user project —
// it must not depend on anything from this backend package at runtime. We
// transpile it with the real `typescript` compiler and load it as a plain
// CommonJS module inside a throwaway directory tree, with a minimal mocked
// `@cucumber/cucumber` module standing in for the real dependency.

const TEMPLATE_PATH = join(__dirname, 'world.ts.template');
const templateSource = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

function transpile(): string {
  const { outputText, diagnostics } = ts.transpileModule(templateSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    fileName: 'world.ts',
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    throw new Error('world.ts.template failed to transpile: ' + JSON.stringify(diagnostics));
  }
  return outputText;
}

const transpiled = transpile();

interface OriginalCallResult {
  __original: 'getByRole' | 'getByText' | 'getByLabel';
  arg1: unknown;
  arg2: unknown;
}

interface LocatorResult {
  __locator: string;
}

interface TestPage {
  locator: Mock<(selector: string) => LocatorResult>;
  getByRole: Mock<(role: string, options?: { name?: unknown }) => OriginalCallResult>;
  getByText: Mock<(text: unknown, options?: unknown) => OriginalCallResult>;
  getByLabel: Mock<(text: unknown, options?: unknown) => OriginalCallResult>;
  setDefaultTimeout: Mock<(ms: number) => void>;
  _title: string;
  title(): string;
}

interface CustomWorldInstance {
  page: TestPage;
}

interface CustomWorldCtor {
  new (options: Record<string, unknown>): CustomWorldInstance;
}

function isCustomWorldCtor(value: unknown): value is CustomWorldCtor {
  return typeof value === 'function';
}

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, '__pwned');
});

/** Builds a throwaway generated-project layout and loads support/world.js from it. */
function loadCustomWorld(repairJsonContent?: string): CustomWorldCtor {
  const dir = fs.mkdtempSync(join(tmpdir(), 'world-template-'));
  createdDirs.push(dir);

  fs.mkdirSync(join(dir, 'support'), { recursive: true });
  fs.mkdirSync(join(dir, 'node_modules', '@cucumber', 'cucumber'), { recursive: true });

  fs.writeFileSync(
    join(dir, 'node_modules', '@cucumber', 'cucumber', 'package.json'),
    JSON.stringify({ name: '@cucumber/cucumber', version: '0.0.0', main: 'index.js' }),
    'utf-8'
  );
  fs.writeFileSync(
    join(dir, 'node_modules', '@cucumber', 'cucumber', 'index.js'),
    [
      'class World {',
      '  constructor(options) { Object.assign(this, options); }',
      '}',
      'function setWorldConstructor(ctor) { globalThis.__capturedCustomWorld = ctor; }',
      'module.exports = { World, setWorldConstructor };',
    ].join('\n'),
    'utf-8'
  );

  if (repairJsonContent !== undefined) {
    fs.writeFileSync(join(dir, 'repair.json'), repairJsonContent, 'utf-8');
  }

  fs.writeFileSync(join(dir, 'support', 'world.js'), transpiled, 'utf-8');

  Reflect.deleteProperty(globalThis, '__capturedCustomWorld');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(dir, 'support', 'world.js'));
  const captured: unknown = Reflect.get(globalThis, '__capturedCustomWorld');
  if (!isCustomWorldCtor(captured)) throw new Error('setWorldConstructor was never called');
  return captured;
}

function makeMockPage(): TestPage {
  return {
    locator: vi.fn((selector: string) => ({ __locator: selector })),
    getByRole: vi.fn((role: string, options?: { name?: unknown }) => ({ __original: 'getByRole', arg1: role, arg2: options })),
    getByText: vi.fn((text: unknown, options?: unknown) => ({ __original: 'getByText', arg1: text, arg2: options })),
    getByLabel: vi.fn((text: unknown, options?: unknown) => ({ __original: 'getByLabel', arg1: text, arg2: options })),
    setDefaultTimeout: vi.fn(),
    _title: 'real title',
    title(): string {
      return this._title;
    },
  };
}

const VALID_PLAN = {
  version: 1,
  locators: [{ method: 'getByRole', value: 'Submit', role: 'button', selector: '[data-testid="submit"]' }],
  actionTimeoutMs: 45000,
};

const INVALID_REPAIR_PLAN_MESSAGE = 'Invalid repair plan: repair.json failed validation.';

describe('generated support/world.ts — repair adapter', () => {
  it('typechecks the real template with the generated-project compiler options', () => {
    const worldPath = join(__dirname, 'world.ts');
    const typesPath = join(__dirname, 'world-dependencies.d.ts');
    // Cucumber is generated-project-only; use installed Playwright and Node types.
    const dependencyTypes = `
      declare module '@cucumber/cucumber' {
        export interface IWorldOptions { parameters: unknown; }
        export class World { constructor(options: IWorldOptions); }
        export function setWorldConstructor(world: typeof World): void;
      }
      declare module '@playwright/test' {
        export type { Browser, BrowserContext, Page } from 'playwright-core';
      }
    `;
    // Mirrors packager.ts TSCONFIG; noEmit keeps compilation in memory.
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      lib: ['lib.es2022.d.ts'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileName === worldPath) return ts.createSourceFile(fileName, templateSource, languageVersion);
      if (fileName === typesPath) return ts.createSourceFile(fileName, dependencyTypes, languageVersion);
      return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };
    const program = ts.createProgram([worldPath, typesPath], options, host);
    expect(ts.version).toBe('5.5.4');
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    )).toEqual([]);
  });

  it('routes a matching getByRole source to the real locator for the repaired selector', () => {
    const CustomWorld = loadCustomWorld(JSON.stringify(VALID_PLAN));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    const result = world.page.getByRole('button', { name: 'Submit' });

    expect(page.locator).toHaveBeenCalledWith('[data-testid="submit"]');
    expect(result).toEqual({ __locator: '[data-testid="submit"]' });
    expect(page.getByRole).not.toHaveBeenCalled();
  });

  it('passes through a non-matching getByRole call unchanged', () => {
    const CustomWorld = loadCustomWorld(JSON.stringify(VALID_PLAN));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    const result = world.page.getByRole('button', { name: 'Cancel' });

    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Cancel' });
    expect(result).toEqual({ __original: 'getByRole', arg1: 'button', arg2: { name: 'Cancel' } });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('leaves a RegExp getByText argument untouched even if a string entry matches', () => {
    const plan = {
      version: 1,
      locators: [{ method: 'getByText', value: 'Submit', selector: 'text=Submitted' }],
      actionTimeoutMs: 30000,
    };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    const pattern = /Submit/;
    const result = world.page.getByText(pattern);

    expect(page.getByText).toHaveBeenCalledWith(pattern, undefined);
    expect(result).toEqual({ __original: 'getByText', arg1: pattern, arg2: undefined });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('binds every other Page method to the real page', () => {
    const CustomWorld = loadCustomWorld(JSON.stringify(VALID_PLAN));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    expect(world.page.title()).toBe('real title');
  });

  it('applies actionTimeoutMs from the plan when the page is assigned', () => {
    const CustomWorld = loadCustomWorld(JSON.stringify(VALID_PLAN));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    expect(page.setDefaultTimeout).toHaveBeenCalledWith(45000);
  });

  it('keeps original behavior and skips setDefaultTimeout when repair.json is absent', () => {
    const CustomWorld = loadCustomWorld(undefined);
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    expect(page.setDefaultTimeout).not.toHaveBeenCalled();
    expect(world.page.getByRole('button', { name: 'Submit' })).toEqual({
      __original: 'getByRole',
      arg1: 'button',
      arg2: { name: 'Submit' },
    });
  });

  it('does not execute a selector string that looks like a JS payload — it stays inert locator data', () => {
    const plan = {
      version: 1,
      locators: [
        { method: 'getByRole', value: 'Pwn', role: 'button', selector: '"); globalThis.__pwned = true; ("' },
      ],
      actionTimeoutMs: 30000,
    };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    const world = new CustomWorld({});
    const page = makeMockPage();
    world.page = page;

    const result = world.page.getByRole('button', { name: 'Pwn' });

    expect(page.locator).toHaveBeenCalledWith('"); globalThis.__pwned = true; ("');
    expect(result).toEqual({ __locator: '"); globalThis.__pwned = true; ("' });
    expect(Reflect.get(globalThis, '__pwned')).toBeUndefined();
  });

  it('throws a fixed message for malformed JSON instead of defaulting to empty', () => {
    const CustomWorld = loadCustomWorld('{ not valid json');
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('throws a fixed message for an unknown top-level key', () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 30000, extra: 'nope' };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('throws a fixed message for an unknown locator key', () => {
    const plan = {
      version: 1,
      locators: [{ method: 'getByText', value: 'Submit', selector: 'text=Submit', exec: 'rm -rf /' }],
      actionTimeoutMs: 30000,
    };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('rejects an XPath selector', () => {
    const plan = {
      version: 1,
      locators: [{ method: 'getByText', value: 'Submit', selector: '//button[@id="submit"]' }],
      actionTimeoutMs: 30000,
    };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('rejects duplicate locator sources (same method/role/value)', () => {
    const plan = {
      version: 1,
      locators: [
        { method: 'getByRole', value: 'Submit', role: 'button', selector: '[data-testid="submit-a"]' },
        { method: 'getByRole', value: 'Submit', role: 'button', selector: '[data-testid="submit-b"]' },
      ],
      actionTimeoutMs: 30000,
    };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('rejects an actionTimeoutMs outside the 30000-45000 bound', () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 60000 };
    const CustomWorld = loadCustomWorld(JSON.stringify(plan));
    expect(() => new CustomWorld({})).toThrow(INVALID_REPAIR_PLAN_MESSAGE);
  });

  it('only ever reads the fixed repair.json path, never an arbitrary one', () => {
    const CustomWorld = loadCustomWorld(JSON.stringify(VALID_PLAN));
    const repairPath = join(fs.realpathSync(createdDirs[createdDirs.length - 1]), 'repair.json');
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    new CustomWorld({});

    expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(readFileSyncSpy).toHaveBeenCalledWith(repairPath, 'utf-8');
  });
});
