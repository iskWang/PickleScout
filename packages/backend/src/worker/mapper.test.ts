import { describe, it, expect } from 'vitest';
import { buildPageModel, buildSelectorRegistry } from './mapper';
import type { ActionLogEntry } from '../types';

function entry(overrides: Partial<ActionLogEntry>): ActionLogEntry {
  return {
    id: 'e1',
    type: 'click',
    timestamp: 0,
    ...overrides,
  };
}

describe('buildPageModel', () => {
  it('maps css selectorStrategy to selectorType css', () => {
    const model = buildPageModel([entry({ selector: '#submit', selectorStrategy: 'css' })]);
    expect(model.elements[0].selectorType).toBe('css');
  });

  it('maps aria-label selectorStrategy to selectorType aria', () => {
    const model = buildPageModel([entry({ selector: '[aria-label="Close"]', selectorStrategy: 'aria-label' })]);
    expect(model.elements[0].selectorType).toBe('aria');
  });

  it('maps xpath selector (starts with /) to selectorType xpath', () => {
    const model = buildPageModel([entry({ selector: '/html/body/div', selectorStrategy: 'css' })]);
    expect(model.elements[0].selectorType).toBe('xpath');
  });

  it('maps double-slash xpath selector to selectorType xpath', () => {
    const model = buildPageModel([entry({ selector: '//button[@id="ok"]' })]);
    expect(model.elements[0].selectorType).toBe('xpath');
  });

  it('skips goto and wait entries', () => {
    const model = buildPageModel([
      entry({ type: 'goto', url: 'https://example.com', selector: undefined }),
      entry({ type: 'wait', selector: undefined }),
      entry({ type: 'click', selector: '#btn' }),
    ]);
    expect(model.elements).toHaveLength(1);
  });

  it('skips entries without a selector', () => {
    const model = buildPageModel([entry({ selector: undefined })]);
    expect(model.elements).toHaveLength(0);
  });

  it('picks up url from first goto entry', () => {
    const model = buildPageModel([
      entry({ type: 'goto', url: 'https://example.com', selector: undefined }),
      entry({ type: 'click', selector: '#btn' }),
    ]);
    expect(model.url).toBe('https://example.com');
  });
});

describe('buildSelectorRegistry', () => {
  it('converts XPath selector to getByText fallback', () => {
    const model = buildPageModel([entry({ selector: '/html/body/button', text: 'Login', selectorStrategy: 'css' })]);
    const registry = buildSelectorRegistry(model);
    const key = Object.keys(registry)[0];
    expect(registry[key]).toContain('getByText(');
  });

  it('converts data-testid CSS selector to getByTestId', () => {
    const model = buildPageModel([entry({ selector: '[data-testid="submit-btn"]' })]);
    const registry = buildSelectorRegistry(model);
    const key = Object.keys(registry)[0];
    expect(registry[key]).toBe('getByTestId("submit-btn")');
  });

  it('converts aria-label CSS selector to getByLabel', () => {
    const model = buildPageModel([entry({ selector: '[aria-label="Search"]' })]);
    const registry = buildSelectorRegistry(model);
    const key = Object.keys(registry)[0];
    expect(registry[key]).toBe('getByLabel("Search")');
  });

  it('falls back to locator() for plain CSS', () => {
    const model = buildPageModel([entry({ selector: '.o_form_button_save' })]);
    const registry = buildSelectorRegistry(model);
    const key = Object.keys(registry)[0];
    expect(registry[key]).toContain('locator(');
  });
});
