import type { Template } from './index';

const template: Template = {
  templateId: 'assert_not_visible',
  requiredParams: ['text'],
  gherkinVerb: 'Then',
  stepPattern: 'I should not see {string}',
  example: 'Then I should not see "Error"',
  implementation: `Then('I should not see {string}', async function(this: CustomWorld, text: string) {
  await expect(this.page.getByText(text)).not.toBeVisible({ timeout: 15_000 });
});`,
};

export default template;
