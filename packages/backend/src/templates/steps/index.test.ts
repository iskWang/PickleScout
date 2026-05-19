import { describe, it, expect } from 'vitest';
import { TEMPLATE_CATALOG } from './index';

describe('TEMPLATE_CATALOG', () => {
  it('has at least 10 entries', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it('every template has required fields', () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(t.templateId, `${t.templateId} missing templateId`).toBeTruthy();
      expect(Array.isArray(t.requiredParams), `${t.templateId} requiredParams not array`).toBe(true);
      expect(['Given', 'When', 'Then']).toContain(t.gherkinVerb);
      expect(t.stepPattern, `${t.templateId} missing stepPattern`).toBeTruthy();
      expect(t.example, `${t.templateId} missing example`).toBeTruthy();
      expect(t.implementation, `${t.templateId} missing implementation`).toBeTruthy();
    }
  });

  it('no template implementation contains document. or window.', () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(t.implementation, `${t.templateId} uses document.`).not.toMatch(/\bdocument\./);
      expect(t.implementation, `${t.templateId} uses window.`).not.toMatch(/\bwindow\./);
    }
  });

  it('no template implementation contains HTMLElement or HTMLInputElement', () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(t.implementation, `${t.templateId} uses HTMLElement`).not.toContain('HTMLElement');
    }
  });

  it('no template implementation contains XPath expressions', () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(t.implementation, `${t.templateId} uses XPath`).not.toMatch(/\/html\[|\/\//);
    }
  });

  it('all templateIds are unique', () => {
    const ids = TEMPLATE_CATALOG.map((t) => t.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Then templates contain expect() in implementation', () => {
    const thenTemplates = TEMPLATE_CATALOG.filter((t) => t.gherkinVerb === 'Then');
    for (const t of thenTemplates) {
      expect(t.implementation, `${t.templateId} Then step has no expect()`).toContain('expect(');
    }
  });
});
