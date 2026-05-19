import type { Template } from './index';

const template: Template = {
  templateId: 'click_by_label',
  requiredParams: ['label'],
  gherkinVerb: 'When',
  stepPattern: 'I click the {string} field',
  example: 'When I click the "Email" field',
  implementation: `When('I click the {string} field', async function(this: CustomWorld, label: string) {
  await this.page.getByLabel(label).click();
});`,
};

export default template;
