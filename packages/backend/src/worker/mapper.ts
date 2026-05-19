import type { ActionLogEntry, PageModel, PageElement, SelectorRegistry } from '../types';

function selectorType(entry: ActionLogEntry): PageElement['selectorType'] {
  const sel = entry.selector ?? '';
  if (sel.startsWith('/') || sel.startsWith('//')) return 'xpath';
  if (entry.selectorStrategy === 'aria-label' || entry.selectorStrategy === 'role') return 'aria';
  if (entry.selectorStrategy === 'text') return 'text';
  return 'css';
}

export function buildPageModel(entries: ActionLogEntry[]): PageModel {
  const elements: PageElement[] = [];

  for (const entry of entries) {
    if (!entry.selector) continue;
    if (entry.type === 'goto' || entry.type === 'wait' || entry.type === 'assert') continue;

    elements.push({
      label: entry.text ?? entry.value ?? entry.selector,
      role: entry.type,
      selector: entry.selector,
      selectorType: selectorType(entry),
      description: entry.text ?? entry.value ?? `${entry.type} ${entry.selector}`,
    });
  }

  return {
    url: entries.find((e) => e.url)?.url ?? '',
    elements,
    forms: [],
    navigation: [],
  };
}

function toLocatorExpr(el: PageElement): string {
  const sel = el.selector;

  if (el.selectorType === 'xpath') {
    return `getByText(${JSON.stringify(el.description)})`;
  }

  const testidMatch = sel.match(/\[data-testid=['"]?([^'"]+?)['"]?\]/);
  if (testidMatch) return `getByTestId(${JSON.stringify(testidMatch[1])})`;

  const ariaLabelMatch = sel.match(/\[aria-label=['"]?([^'"]+?)['"]?\]/);
  if (ariaLabelMatch) return `getByLabel(${JSON.stringify(ariaLabelMatch[1])})`;

  const roleMatch = sel.match(/\[role=['"]?([^'"]+?)['"]?\]/);
  if (roleMatch) {
    const name = el.label !== el.selector ? el.label : '';
    const nameArg = name ? `, { name: ${JSON.stringify(name)} }` : '';
    return `getByRole(${JSON.stringify(roleMatch[1])}${nameArg})`;
  }

  if (el.selectorType === 'aria') return `getByLabel(${JSON.stringify(el.label)})`;
  if (el.selectorType === 'text') return `getByText(${JSON.stringify(el.label)})`;

  return `locator(${JSON.stringify(sel)})`;
}

export function buildSelectorRegistry(pageModel: PageModel): SelectorRegistry {
  const registry: SelectorRegistry = {};
  for (const el of pageModel.elements) {
    const key = el.label || el.selector;
    registry[key] = toLocatorExpr(el);
  }
  return registry;
}
