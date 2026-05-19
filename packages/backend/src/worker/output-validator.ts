/**
 * Output Validator — static analysis of assembled feature + step files.
 *
 * Runs after assembleStepFiles/assembleFeatureFiles, before packaging.
 * Catches structural issues that neither Zod nor unit tests can prevent
 * (e.g. self-healer rewrites, step pattern mismatches, missing assertions).
 */

import type { Template } from '../templates/steps/index';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const ASSERT_TEMPLATE_PATTERNS = [
  'should see',
  'should not see',
  'URL contains',
];

// ─── Feature file checks ──────────────────────────────────────────────────────

function extractGherkinSteps(featureContent: string): string[] {
  return featureContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(Given|When|Then|And|But)\s/.test(l))
    .map((l) => l.replace(/^(Given|When|Then|And|But)\s+/, ''));
}

function extractScenarios(featureContent: string): Array<{ name: string; steps: string[] }> {
  const scenarios: Array<{ name: string; steps: string[] }> = [];
  let current: { name: string; steps: string[] } | null = null;
  for (const line of featureContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Scenario:')) {
      if (current) scenarios.push(current);
      current = { name: trimmed.slice('Scenario:'.length).trim(), steps: [] };
    } else if (current && /^(Given|When|Then|And|But)\s/.test(trimmed)) {
      current.steps.push(trimmed);
    }
  }
  if (current) scenarios.push(current);
  return scenarios;
}

function validateFeatureFile(
  featureContent: string,
  stepDefinitions: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scenarios = extractScenarios(featureContent);

  for (const scenario of scenarios) {
    if (scenario.steps.length === 0) {
      issues.push({ severity: 'error', code: 'EMPTY_SCENARIO', message: `Scenario "${scenario.name}" has no steps` });
      continue;
    }

    // RULE 1: first step must be Given I navigate to
    const firstStep = scenario.steps[0];
    if (!firstStep.toLowerCase().startsWith('given i navigate to')) {
      issues.push({
        severity: 'error',
        code: 'MISSING_NAVIGATE',
        message: `Scenario "${scenario.name}": first step must be "Given I navigate to ...", got "${firstStep}"`,
      });
    }

    // RULE 2: must have at least one Then assertion
    const hasThen = scenario.steps.some(
      (s) => s.startsWith('Then') && ASSERT_TEMPLATE_PATTERNS.some((p) => s.includes(p)),
    );
    if (!hasThen) {
      issues.push({
        severity: 'error',
        code: 'MISSING_ASSERTION',
        message: `Scenario "${scenario.name}": no Then assertion step (should see / should not see / URL contains)`,
      });
    }
  }

  // RULE 3: every step has a matching definition
  const allSteps = extractGherkinSteps(featureContent);
  for (const step of allSteps) {
    const matched = stepDefinitions.some((def) => stepMatchesDefinition(step, def));
    if (!matched) {
      issues.push({
        severity: 'error',
        code: 'UNMATCHED_STEP',
        message: `No step definition matches: "${step}"`,
      });
    }
  }

  return issues;
}

// ─── Step file checks ─────────────────────────────────────────────────────────

function validateStepFile(stepsContent: string, catalog: Template[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // RULE 4: no XPath
  if (/xpath=|\/html\[|\/\/[a-z]/i.test(stepsContent)) {
    issues.push({ severity: 'error', code: 'XPATH_IN_STEPS', message: 'steps.ts contains XPath selector' });
  }

  // RULE 5a: no browser globals
  for (const g of ['document.', 'window.', 'HTMLElement', 'HTMLInputElement']) {
    if (stepsContent.includes(g)) {
      issues.push({ severity: 'error', code: 'BROWSER_GLOBAL', message: `steps.ts uses browser global: ${g}` });
    }
  }

  // RULE 5b: setDefaultTimeout belongs in hooks.ts, not steps.ts
  if (/setDefaultTimeout\s*\(/.test(stepsContent)) {
    issues.push({ severity: 'error', code: 'ROGUE_SET_TIMEOUT', message: 'steps.ts contains setDefaultTimeout() — self-healer bypass detected; timeout belongs in hooks.ts via @cucumber/cucumber' });
  }

  // RULE 6: template implementations must not be modified by self-healer
  for (const tpl of catalog) {
    if (!stepsContent.includes(tpl.stepPattern)) continue; // template not used
    if (!stepsContent.includes(tpl.implementation)) {
      issues.push({
        severity: 'error',
        code: 'TEMPLATE_MODIFIED',
        message: `Template "${tpl.templateId}" implementation was modified (self-healer rewrite detected)`,
      });
    }
  }

  return issues;
}

// ─── Step pattern matching helper ─────────────────────────────────────────────

function stepMatchesDefinition(gherkinStep: string, definition: string): boolean {
  // definition is like: 'I navigate to {string}'
  const escaped = definition
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{string\\\}/g, '"[^"]*"')
    .replace(/\\\{int\\\}/g, '\\d+');
  return new RegExp(`^${escaped}$`).test(gherkinStep);
}

function extractStepDefinitionPatterns(stepsContent: string): string[] {
  const matches = stepsContent.matchAll(
    /(?:Given|When|Then)\(\s*['"`]([^'"`]+)['"`]/g,
  );
  return [...matches].map((m) => m[1]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function validateOutput(
  featureFiles: Array<{ filename: string; content: string }>,
  stepFiles: Array<{ filename: string; content: string }>,
  catalog: Template[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const allStepDefs = stepFiles.flatMap((f) => extractStepDefinitionPatterns(f.content));

  for (const feature of featureFiles) {
    const featureIssues = validateFeatureFile(feature.content, allStepDefs);
    featureIssues.forEach((iss) => {
      issues.push({ ...iss, message: `[${feature.filename}] ${iss.message}` });
    });
  }

  for (const stepFile of stepFiles) {
    const stepIssues = validateStepFile(stepFile.content, catalog);
    stepIssues.forEach((iss) => {
      issues.push({ ...iss, message: `[${stepFile.filename}] ${iss.message}` });
    });
  }

  return {
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
