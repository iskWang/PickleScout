import { describe, it, expect } from 'vitest';
import { assembleStepFiles, assembleFeatureFiles } from './assembler';
import { TEMPLATE_CATALOG } from '../templates/steps/index';
import type { IntentSpec } from '../types';

const MINIMAL_SPEC: IntentSpec = {
  version: '1.0.0',
  targetUrl: 'https://example.com',
  scenarios: [
    {
      name: 'Navigate to page',
      steps: [
        { templateId: 'navigate_to_url', params: { url: 'https://example.com' }, description: 'go to url' },
        { templateId: 'assert_visible', params: { text: 'Welcome' }, description: 'check welcome' },
      ],
    },
  ],
};

describe('assembleStepFiles', () => {
  it('prepends the three mandatory import lines', () => {
    const { files } = assembleStepFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(files[0].content).toContain("import { Given, When, Then } from '@cucumber/cucumber';");
    expect(files[0].content).toContain("import { expect } from '@playwright/test';");
    expect(files[0].content).toContain("import type { CustomWorld } from '../support/world';");
  });

  it('includes the implementation for used templates', () => {
    const { files } = assembleStepFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(files[0].content).toContain("page.goto(url, { waitUntil: 'domcontentloaded' })");
    expect(files[0].content).toContain("getByText(text)");
  });

  it('deduplicates template implementations across scenarios', () => {
    const spec: IntentSpec = {
      ...MINIMAL_SPEC,
      scenarios: [
        { name: 'A', steps: [{ templateId: 'navigate_to_url', params: { url: '/a' }, description: '' }] },
        { name: 'B', steps: [{ templateId: 'navigate_to_url', params: { url: '/b' }, description: '' }] },
      ],
    };
    const { files } = assembleStepFiles(spec, TEMPLATE_CATALOG);
    const count = (files[0].content.match(/page\.goto/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('tracks unknown templateIds in unimplementedTemplates', () => {
    const spec: IntentSpec = {
      ...MINIMAL_SPEC,
      scenarios: [
        { name: 'A', steps: [{ templateId: 'nonexistent_template', params: {}, description: 'unknown' }] },
      ],
    };
    const { unimplementedTemplates } = assembleStepFiles(spec, TEMPLATE_CATALOG);
    expect(unimplementedTemplates).toContain('nonexistent_template');
  });

  it('does not emit implementation for unknown templates', () => {
    const spec: IntentSpec = {
      ...MINIMAL_SPEC,
      scenarios: [
        { name: 'A', steps: [{ templateId: 'mystery_template', params: {}, description: 'x' }] },
      ],
    };
    const { files } = assembleStepFiles(spec, TEMPLATE_CATALOG);
    expect(files[0].content).not.toContain('mystery_template');
  });

  it('returns filename steps.ts', () => {
    const { files } = assembleStepFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(files[0].filename).toBe('steps.ts');
  });

  it('navigate_to_url uses domcontentloaded and has no baseUrl or hardcoded timeout', () => {
    const spec: IntentSpec = {
      ...MINIMAL_SPEC,
      scenarios: [
        { name: 'A', steps: [{ templateId: 'navigate_to_url', params: { url: 'https://example.com' }, description: '' }] },
      ],
    };
    const { files } = assembleStepFiles(spec, TEMPLATE_CATALOG);
    const content = files[0].content;
    expect(content).toContain("waitUntil: 'domcontentloaded'");
    expect(content).not.toContain('baseUrl');
    expect(content).not.toMatch(/goto\(.*timeout:\s*\d/);
  });

  it('every used template emits its exact implementation string unchanged', () => {
    const { files } = assembleStepFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    const usedIds = MINIMAL_SPEC.scenarios.flatMap((s) => s.steps.map((st) => st.templateId));
    for (const id of usedIds) {
      const tpl = TEMPLATE_CATALOG.find((t) => t.templateId === id)!;
      expect(files[0].content, `${id} implementation was modified`).toContain(tpl.implementation);
    }
  });
});

describe('assembleFeatureFiles', () => {
  it('generates a Feature block', () => {
    const features = assembleFeatureFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(features[0].content).toContain('Feature:');
  });

  it('includes the scenario name', () => {
    const features = assembleFeatureFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(features[0].content).toContain('Navigate to page');
  });

  it('fills in param values in the step pattern', () => {
    const features = assembleFeatureFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(features[0].content).toContain('"https://example.com"');
    expect(features[0].content).toContain('"Welcome"');
  });

  it('uses the correct gherkin verb from the template', () => {
    const features = assembleFeatureFiles(MINIMAL_SPEC, TEMPLATE_CATALOG);
    expect(features[0].content).toContain('Given I navigate to');
    expect(features[0].content).toContain('Then I should see');
  });

  it('comments out unknown template steps instead of crashing', () => {
    const spec: IntentSpec = {
      ...MINIMAL_SPEC,
      scenarios: [
        { name: 'A', steps: [{ templateId: 'unknown_op', params: {}, description: 'desc' }] },
      ],
    };
    const features = assembleFeatureFiles(spec, TEMPLATE_CATALOG);
    expect(features[0].content).toContain("# TODO: unknown template 'unknown_op'");
  });
});
