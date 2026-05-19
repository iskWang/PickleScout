import type { Template } from './index';

const template: Template = {
  templateId: 'click_by_text',
  requiredParams: ['text'],
  gherkinVerb: 'When',
  stepPattern: 'I click on {string}',
  example: 'When I click on "Login"',
  implementation: `When('I click on {string}', async function(this: CustomWorld, text: string) {
  await this.page.getByText(text).click();
});`,
};

export default template;
