import { describe, it, expect } from 'vitest';
import { validateOutput } from './output-validator';
import { TEMPLATE_CATALOG } from '../templates/steps/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GOOD_STEPS = `import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import type { CustomWorld } from '../support/world';

Given('I navigate to {string}', async function(this: CustomWorld, url: string) {
  await this.page.goto(url, { waitUntil: 'domcontentloaded' });
});
When('I click the {string} {string}', async function(this: CustomWorld, name: string, role: string) {
  const validRoles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'] as const;
  type ValidRole = typeof validRoles[number];
  const r = validRoles.includes(role as ValidRole) ? (role as ValidRole) : 'button';
  await this.page.getByRole(r, { name }).click();
});
Then('I should see {string}', async function(this: CustomWorld, text: string) {
  await expect(this.page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
});
Then('I should not see {string}', async function(this: CustomWorld, text: string) {
  await expect(this.page.getByText(text)).not.toBeVisible({ timeout: 15_000 });
});`;

const GOOD_FEATURE = `Feature: Sales tests

  Scenario: View sales orders
    Given I navigate to "https://demo.odoo.com/odoo/sales"
    When I click the "Orders" "button"
    Then I should see "Sales Orders"
`;

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('validateOutput — happy path', () => {
  it('returns valid=true for a correct feature + steps pair', () => {
    const result = validateOutput(
      [{ filename: 'test.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ─── RULE 1: navigate_to_url first ───────────────────────────────────────────

describe('RULE 1 — first step must be navigate_to_url', () => {
  it('errors when scenario starts with a When step (no Given navigate)', () => {
    const feature = `Feature: X
  Scenario: Missing navigate
    When I click the "New" "button"
    Then I should see "Record"
`;
    const result = validateOutput(
      [{ filename: 'x.feature', content: feature }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    const err = result.issues.find((i) => i.code === 'MISSING_NAVIGATE');
    expect(err).toBeTruthy();
    expect(result.valid).toBe(false);
  });

  it('passes when scenario correctly starts with Given I navigate to', () => {
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'MISSING_NAVIGATE')).toBeUndefined();
  });
});

// ─── RULE 2: assertion required ───────────────────────────────────────────────

describe('RULE 2 — every scenario must have a Then assertion', () => {
  it('errors when scenario has only Given + When steps', () => {
    const feature = `Feature: X
  Scenario: No assertion
    Given I navigate to "https://example.com"
    When I click the "New" "button"
`;
    const result = validateOutput(
      [{ filename: 'x.feature', content: feature }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'MISSING_ASSERTION')).toBeTruthy();
    expect(result.valid).toBe(false);
  });

  it('passes when Then I should see is present', () => {
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'MISSING_ASSERTION')).toBeUndefined();
  });

  it('passes when Then I should not see is the assertion', () => {
    const feature = `Feature: X
  Scenario: Delete check
    Given I navigate to "https://example.com"
    When I click the "Delete" "button"
    Then I should not see "Record"
`;
    const result = validateOutput(
      [{ filename: 'x.feature', content: feature }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'MISSING_ASSERTION')).toBeUndefined();
  });
});

// ─── RULE 3: step pattern matching ───────────────────────────────────────────

describe('RULE 3 — every Gherkin step must match a step definition', () => {
  it('errors when feature uses a step not in steps.ts', () => {
    const feature = `Feature: X
  Scenario: Missing def
    Given I navigate to "https://example.com"
    When I do something completely undefined
    Then I should see "Result"
`;
    const result = validateOutput(
      [{ filename: 'x.feature', content: feature }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'UNMATCHED_STEP')).toBeTruthy();
    expect(result.valid).toBe(false);
  });
});

// ─── RULE 4: no XPath ────────────────────────────────────────────────────────

describe('RULE 4 — no XPath in steps.ts', () => {
  it('errors when self-healer rewrites a step to use xpath', () => {
    const badSteps = GOOD_STEPS + `\nWhen('I hack it', async function() { await this.page.locator('xpath=/html[1]/body[1]').click(); });`;
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: badSteps }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'XPATH_IN_STEPS')).toBeTruthy();
  });
});

// ─── RULE 6: template implementation fidelity ─────────────────────────────────

describe('RULE 6 — template implementations must not be modified', () => {
  it('errors when self-healer adds baseUrl to navigate_to_url', () => {
    const selfHealedSteps = GOOD_STEPS.replace(
      "await this.page.goto(url, { waitUntil: 'domcontentloaded' });",
      `const baseUrl = 'https://demo.odoo.com/odoo';
  const fullUrl = url.startsWith('http') ? url : baseUrl + url;
  await this.page.goto(fullUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });`,
    );
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: selfHealedSteps }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'TEMPLATE_MODIFIED')).toBeTruthy();
    expect(result.valid).toBe(false);
  });

  it('errors when self-healer adds setDefaultTimeout inline', () => {
    const selfHealedSteps = `import { Given, When, Then, setDefaultTimeout } from '@cucumber/cucumber';\nimport { expect } from '@playwright/test';\nimport type { CustomWorld } from '../support/world';\n\nsetDefaultTimeout(60000);\n` + GOOD_STEPS.slice(GOOD_STEPS.indexOf('\nGiven'));
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: selfHealedSteps }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'ROGUE_SET_TIMEOUT')).toBeTruthy();
    expect(result.valid).toBe(false);
  });

  it('errors when self-healer adds waitFor to click_by_role', () => {
    const selfHealedSteps = GOOD_STEPS.replace(
      'await this.page.getByRole(r, { name }).click();',
      `await this.page.getByRole(r, { name }).waitFor({ state: 'visible', timeout: 10000 });
  await this.page.getByRole(r, { name }).click({ timeout: 10000 });`,
    );
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: selfHealedSteps }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'TEMPLATE_MODIFIED')).toBeTruthy();
  });

  it('passes when all implementations exactly match catalog', () => {
    const result = validateOutput(
      [{ filename: 'x.feature', content: GOOD_FEATURE }],
      [{ filename: 'steps.ts', content: GOOD_STEPS }],
      TEMPLATE_CATALOG,
    );
    expect(result.issues.find((i) => i.code === 'TEMPLATE_MODIFIED')).toBeUndefined();
  });
});
