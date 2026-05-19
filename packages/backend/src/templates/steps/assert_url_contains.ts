import type { Template } from './index';

const template: Template = {
  templateId: 'assert_url_contains',
  requiredParams: ['path'],
  gherkinVerb: 'Then',
  stepPattern: 'the URL contains {string}',
  example: 'Then the URL contains "/dashboard"',
  implementation: `Then('the URL contains {string}', async function(this: CustomWorld, path: string) {
  expect(this.page.url()).toContain(path);
});`,
};

export default template;
