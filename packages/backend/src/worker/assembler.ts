import type { Template } from '../templates/steps/index';
import type { IntentSpec } from '../types';

export interface AssembleResult {
  files: Array<{ filename: string; content: string }>;
  unimplementedTemplates: string[];
}

function fillStepPattern(template: Template, params: Record<string, string>): string {
  let pattern = template.stepPattern;
  for (const paramName of template.requiredParams) {
    const value = params[paramName] ?? '';
    pattern = pattern.replace('{string}', `"${value}"`);
  }
  return pattern;
}

const STEP_FILE_IMPORTS = [
  "import { Given, When, Then } from '@cucumber/cucumber';",
  "import { expect } from '@playwright/test';",
  "import type { CustomWorld } from '../support/world';",
].join('\n');

export function assembleStepFiles(intentSpec: IntentSpec, catalog: Template[]): AssembleResult {
  const catalogMap = new Map(catalog.map((t) => [t.templateId, t]));
  const usedIds = new Set<string>();
  const unimplementedTemplates: string[] = [];

  for (const scenario of intentSpec.scenarios) {
    for (const step of scenario.steps) {
      usedIds.add(step.templateId);
    }
  }

  const parts: string[] = [STEP_FILE_IMPORTS, ''];

  for (const templateId of usedIds) {
    const template = catalogMap.get(templateId);
    if (template) {
      parts.push(template.implementation);
      parts.push('');
    } else {
      unimplementedTemplates.push(templateId);
    }
  }

  return {
    files: [{ filename: 'steps.ts', content: parts.join('\n') }],
    unimplementedTemplates,
  };
}

export function assembleFeatureFiles(
  intentSpec: IntentSpec,
  catalog: Template[],
): Array<{ filename: string; content: string }> {
  const catalogMap = new Map(catalog.map((t) => [t.templateId, t]));

  const lines: string[] = [`Feature: Generated tests for ${intentSpec.targetUrl}`, ''];

  for (const scenario of intentSpec.scenarios) {
    lines.push(`  Scenario: ${scenario.name}`);
    for (const step of scenario.steps) {
      const template = catalogMap.get(step.templateId);
      if (!template) {
        lines.push(`    # TODO: unknown template '${step.templateId}' — ${step.description}`);
        continue;
      }
      const stepText = fillStepPattern(template, step.params);
      lines.push(`    ${template.gherkinVerb} ${stepText}`);
    }
    lines.push('');
  }

  return [{ filename: '01_generated.feature', content: lines.join('\n') }];
}
