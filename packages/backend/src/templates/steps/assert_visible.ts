import type { Template } from './index';

const template: Template = {
  templateId: 'assert_visible',
  requiredParams: ['text'],
  gherkinVerb: 'Then',
  stepPattern: 'I should see {string}',
  example: 'Then I should see "Welcome"',
  implementation: `Then('I should see {string}', async function(this: CustomWorld, text: string) {
  await expect(this.page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
});`,
};

export default template;
