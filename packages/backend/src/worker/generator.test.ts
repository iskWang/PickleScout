import { describe, it, expect } from 'vitest';
import { extractStepPatterns, dedupeStepFile, extractRequiredStepCoverage, STEP_SHARED_RULES, stripMarkdownJson, formatActionLogEntry, extractObservedElements } from './generator';

const IMPORTS = `import { Given, When, Then } from '@cucumber/cucumber';\nimport { page } from '../support/world';\n\n`;

// ─── extractStepPatterns ──────────────────────────────────────────────────────

describe('extractStepPatterns', () => {
  it('extracts single-quote string pattern', () => {
    const patterns = extractStepPatterns(`Given('I am logged in', async () => {})`);
    expect(patterns.has('Given:I am logged in')).toBe(true);
  });

  it('extracts double-quote string pattern', () => {
    const patterns = extractStepPatterns(`When("user clicks submit", async () => {})`);
    expect(patterns.has('When:user clicks submit')).toBe(true);
  });

  it('extracts backtick string pattern', () => {
    const patterns = extractStepPatterns('Then(`I see {string}`, async () => {})');
    expect(patterns.has('Then:I see {string}')).toBe(true);
  });

  it('extracts regex pattern', () => {
    const patterns = extractStepPatterns(`Given(/^I am on the "([^"]+)" page$/, async () => {})`);
    expect(patterns.has('Given:/^I am on the "([^"]+)" page$/')).toBe(true);
  });

  it('handles inner double-quotes inside a single-quote string', () => {
    const patterns = extractStepPatterns(`When('I click "submit"', async () => {})`);
    expect(patterns.has('When:I click "submit"')).toBe(true);
  });

  it('scopes keys by step type — same text under Given and When produces two keys', () => {
    const content = `Given('page loads', async () => {})\nWhen('page loads', async () => {})`;
    const patterns = extractStepPatterns(content);
    expect(patterns.has('Given:page loads')).toBe(true);
    expect(patterns.has('When:page loads')).toBe(true);
    expect(patterns.size).toBe(2);
  });

  it('scopes keys by step type — Given and Then with same text are two separate keys', () => {
    const content = `Given('user is logged in', async () => {})\nThen('user is logged in', async () => {})`;
    const patterns = extractStepPatterns(content);
    expect(patterns.has('Given:user is logged in')).toBe(true);
    expect(patterns.has('Then:user is logged in')).toBe(true);
    expect(patterns.size).toBe(2);
  });

  it('returns empty Set for empty content', () => {
    expect(extractStepPatterns('').size).toBe(0);
  });

  it('extracts multiple patterns from the same file', () => {
    const content = [
      `Given('I am logged in', async () => {})`,
      `When('I click the menu', async () => {})`,
      `Then(/^I see "([^"]+)"$/, async () => {})`,
    ].join('\n');
    expect(extractStepPatterns(content).size).toBe(3);
  });
});

// ─── dedupeStepFile ───────────────────────────────────────────────────────────

describe('dedupeStepFile', () => {
  it('removes a step block whose pattern key is in commonKeys', () => {
    const content = `${IMPORTS}Given('I am logged in', async () => {\n  await page.goto('/login');\n});\n`;
    const result = dedupeStepFile(content, new Set(['Given:I am logged in']));
    expect(result).not.toContain("Given('I am logged in'");
    expect(result).toContain('import');
  });

  it('keeps a step block whose pattern key is NOT in commonKeys', () => {
    const content = `${IMPORTS}When('I fill the form', async () => {\n  await page.fill('input', 'hello');\n});\n`;
    const result = dedupeStepFile(content, new Set(['Given:some other step']));
    expect(result).toContain("When('I fill the form'");
  });

  it('returns content unchanged when commonKeys is empty', () => {
    const content = `${IMPORTS}Given('step one', async () => {});`;
    expect(dedupeStepFile(content, new Set())).toBe(content);
  });

  it('returns content unchanged when no steps match commonKeys', () => {
    const content = `${IMPORTS}Then('I see results', async () => {});`;
    expect(dedupeStepFile(content, new Set(['Given:unrelated step']))).toBe(content);
  });

  it('removes a regex-pattern step block in commonKeys', () => {
    const content = `${IMPORTS}Given(/^I am on the "([^"]+)" page$/, async () => {});`;
    const result = dedupeStepFile(content, new Set(['Given:/^I am on the "([^"]+)" page$/']));
    expect(result).not.toContain('Given(/^I am on');
    expect(result).toContain('import');
  });

  it('does not remove a When block when only the Given version is in commonKeys', () => {
    const content = `${IMPORTS}When('page loads', async () => {});`;
    const result = dedupeStepFile(content, new Set(['Given:page loads']));
    expect(result).toContain("When('page loads'");
  });

  it('removes multiple duplicate blocks and leaves unique steps intact — end-to-end', () => {
    const content = `${IMPORTS}Given('setup', async () => {});\nWhen('user acts', async () => {});\nThen('I verify unique', async () => {});\n`;
    const result = dedupeStepFile(content, new Set(['Given:setup', 'When:user acts']));
    expect(result).not.toContain("Given('setup'");
    expect(result).not.toContain("When('user acts'");
    expect(result).toContain("Then('I verify unique'");
    expect(result).toContain('import');
  });
});

// ─── extractRequiredStepCoverage ──────────────────────────────────────────────

describe('extractRequiredStepCoverage', () => {
  it('extracts Given/When/Then steps and converts quoted strings to {string}', () => {
    const feature = {
      filename: 'test.feature',
      content: [
        'Feature: Sales',
        '  Scenario: Create order',
        '    Given I am logged in',
        '    When I click the "New" button',
        '    Then I should see "Success"',
      ].join('\n'),
    };
    const result = extractRequiredStepCoverage([feature]);
    expect(result).toContainEqual({ keyword: 'Given', pattern: 'I am logged in' });
    expect(result).toContainEqual({ keyword: 'When', pattern: 'I click the {string} button' });
    expect(result).toContainEqual({ keyword: 'Then', pattern: 'I should see {string}' });
  });

  it('resolves And/But to the previous keyword', () => {
    const feature = {
      filename: 'test.feature',
      content: [
        'Feature: X',
        '  Scenario: flow',
        '    Given I am on the page',
        '    When I click "Submit"',
        '    And I enter "123" into the search bar',
        '    Then I see "Result"',
        '    But I do not see "Error"',
      ].join('\n'),
    };
    const result = extractRequiredStepCoverage([feature]);
    const findKw = (pattern: string) => result.find((r) => r.pattern === pattern)?.keyword;
    expect(findKw('I enter {string} into the search bar')).toBe('When');
    expect(findKw('I do not see {string}')).toBe('Then');
  });

  it('deduplicates identical patterns across features', () => {
    const f1 = { filename: 'a.feature', content: 'Feature: A\n  Scenario: s\n    When I click "X"' };
    const f2 = { filename: 'b.feature', content: 'Feature: B\n  Scenario: s\n    When I click "Y"' };
    const result = extractRequiredStepCoverage([f1, f2]);
    const matches = result.filter((r) => r.pattern === 'I click {string}');
    expect(matches).toHaveLength(1);
  });

  it('returns empty array for feature files with no steps', () => {
    const feature = { filename: 'empty.feature', content: 'Feature: Empty\n  Scenario: nothing' };
    expect(extractRequiredStepCoverage([feature])).toHaveLength(0);
  });

  it('catches the exact patterns that caused the Unresolved regression', () => {
    const feature = {
      filename: '01_sales.feature',
      content: [
        'Feature: Sales',
        '  Scenario: Create quotation',
        '    When I click the "Add a product" link',
        '  Scenario: Cancel order',
        '    Then I should see "Cancelled" in the status header',
        '  Scenario: Search',
        '    When I enter "999999999" into the search bar',
      ].join('\n'),
    };
    const result = extractRequiredStepCoverage([feature]);
    const patterns = result.map((r) => r.pattern);
    expect(patterns).toContain('I click the {string} link');
    expect(patterns).toContain('I should see {string} in the status header');
    expect(patterns).toContain('I enter {string} into the search bar');
  });
});

describe('STEP_SHARED_RULES — runtime guard', () => {
  it('forbids document and window', () => {
    expect(STEP_SHARED_RULES).toContain('NEVER use: document');
    expect(STEP_SHARED_RULES).toContain('window');
  });
  it('forbids HTMLInputElement and HTMLElement', () => {
    expect(STEP_SHARED_RULES).toContain('HTMLInputElement');
    expect(STEP_SHARED_RULES).toContain('HTMLElement');
  });
  it('forbids localStorage, sessionStorage, navigator', () => {
    expect(STEP_SHARED_RULES).toContain('localStorage');
    expect(STEP_SHARED_RULES).toContain('sessionStorage');
    expect(STEP_SHARED_RULES).toContain('navigator');
  });
  it('prescribes world.page as access pattern', () => {
    expect(STEP_SHARED_RULES).toContain('world.page');
  });
  it('forbids XPath', () => {
    expect(STEP_SHARED_RULES).toContain('XPath is FORBIDDEN');
  });
  it('requires expect() in Then steps', () => {
    expect(STEP_SHARED_RULES).toContain('Every Then step must contain at least one expect() call');
  });
  it('specifies all three required imports', () => {
    expect(STEP_SHARED_RULES).toContain('@cucumber/cucumber');
    expect(STEP_SHARED_RULES).toContain('@playwright/test');
    expect(STEP_SHARED_RULES).toContain('../support/world');
  });
});

describe('stripMarkdownJson', () => {
  it('strips ```json fence', () => {
    expect(stripMarkdownJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips plain ``` fence', () => {
    expect(stripMarkdownJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('passes through plain JSON unchanged', () => {
    expect(stripMarkdownJson('{"a":1}')).toBe('{"a":1}');
  });
  it('trims surrounding whitespace', () => {
    expect(stripMarkdownJson('  {"a":1}  ')).toBe('{"a":1}');
  });
  it('returns empty string on empty input', () => {
    expect(stripMarkdownJson('')).toBe('');
  });
});

describe('formatActionLogEntry — XPath suppression', () => {
  it('prefers text label over XPath selector for click entries', () => {
    const entry = {
      id: 'e1', timestamp: 0, type: 'click' as const,
      selector: 'xpath=/html[1]/body[1]/div[1]/button[1]',
      text: 'New quotation button',
    };
    const result = formatActionLogEntry(entry);
    expect(result).toContain('New quotation button');
    expect(result).not.toContain('xpath=');
    expect(result).not.toContain('/html[');
  });

  it('shows url for goto entries (no text on goto)', () => {
    const entry = {
      id: 'e2', timestamp: 0, type: 'goto' as const,
      url: 'https://example.com',
    };
    const result = formatActionLogEntry(entry);
    expect(result).toContain('https://example.com');
    expect(result).not.toContain('xpath=');
  });

  it('falls back to selector when text is absent (e.g. auth fill)', () => {
    const entry = {
      id: 'e3', timestamp: 0, type: 'fill' as const,
      selector: 'username input',
      value: '[REDACTED]',
    };
    const result = formatActionLogEntry(entry);
    expect(result).toContain('username input');
    expect(result).toContain('[REDACTED]');
  });

  it('never emits xpath= prefix into LLM prompt from a real Stagehand-style action log', () => {
    const xpathEntries = [
      { id: 'e1', timestamp: 0, type: 'click' as const, selector: 'xpath=/html[1]/body[1]/header[1]/nav[1]/a[1]', text: 'Home menu link' },
      { id: 'e2', timestamp: 0, type: 'click' as const, selector: 'xpath=/html[1]/body[1]/div[1]/div[2]/div[1]/a[1]', text: 'Discuss module option' },
      { id: 'e3', timestamp: 0, type: 'click' as const, selector: 'xpath=/html[1]/body[1]/header[1]/nav[1]/div[3]/button[1]', text: 'AI button' },
    ];
    const prompt = xpathEntries.map(formatActionLogEntry).join('\n');
    expect(prompt).not.toMatch(/xpath=/);
    expect(prompt).toContain('Home menu link');
    expect(prompt).toContain('Discuss module option');
    expect(prompt).toContain('AI button');
  });
});

// ─── extractObservedElements ──────────────────────────────────────────────────

describe('extractObservedElements — observed elements allowlist', () => {
  const makeEntry = (type: 'click' | 'observe' | 'goto', text?: string, url?: string) =>
    ({ id: 'x', timestamp: 0, type, text, selector: '', url: url ?? '' } as any);

  it('parses "X button" into click_by_role gherkin pattern', () => {
    const entries = [makeEntry('observe', 'New button; Save manually button')];
    const result = extractObservedElements(entries);
    expect(result).toContain('When I click the "New" "button"');
    expect(result).toContain('When I click the "Save manually" "button"');
  });

  it('parses "X link" and "Link to X" into click_by_role link pattern', () => {
    const entries = [makeEntry('observe', 'Quotations link; Link to the Sales Orders list')];
    const result = extractObservedElements(entries);
    expect(result).toContain('When I click the "Quotations" "link"');
    expect(result).toContain('When I click the "Sales Orders list" "link"');
  });

  it('parses "X input field" / "X combobox" into fill pattern', () => {
    const entries = [makeEntry('observe', 'Customer combobox')];
    const result = extractObservedElements(entries);
    expect(result).toContain('When I fill the "Customer" field with "..."');
  });

  it('excludes entries without text', () => {
    const entries = [makeEntry('goto', undefined)];
    expect(extractObservedElements(entries)).toHaveLength(0);
  });

  it('deduplicates by label — same label from two entries appears once', () => {
    const entries = [
      makeEntry('observe', 'New button'),
      makeEntry('click', 'New button to create a new sales order'),
    ];
    const result = extractObservedElements(entries);
    expect(result.filter((g) => g.includes('"New"'))).toHaveLength(1);
  });

  it('excludes elements observed on other pages when targetUrl is given', () => {
    const entries = [
      makeEntry('goto', undefined, 'https://example.com/sales'),
      makeEntry('observe', 'New button; Save button'),
      makeEntry('goto', undefined, 'https://example.com/other'),
      makeEntry('observe', 'Home menu button; Settings link'),
    ];
    const result = extractObservedElements(entries, 'https://example.com/sales');
    expect(result.some((g) => g.includes('"New"'))).toBe(true);
    expect(result.some((g) => g.includes('"Home menu"'))).toBe(false);
    expect(result.some((g) => g.includes('"Settings"'))).toBe(false);
  });

  it('includes elements after returning to target URL', () => {
    const entries = [
      makeEntry('goto', undefined, 'https://example.com/sales'),
      makeEntry('observe', 'New button'),
      makeEntry('goto', undefined, 'https://example.com/other'),
      makeEntry('observe', 'Foreign element button'),
      makeEntry('goto', undefined, 'https://example.com/sales'),
      makeEntry('observe', 'Confirm button'),
    ];
    const result = extractObservedElements(entries, 'https://example.com/sales');
    expect(result.some((g) => g.includes('"New"'))).toBe(true);
    expect(result.some((g) => g.includes('"Confirm"'))).toBe(true);
    expect(result.some((g) => g.includes('"Foreign element"'))).toBe(false);
  });
});
