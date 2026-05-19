import type { Template } from './index';

const template: Template = {
  templateId: 'fill_by_label',
  requiredParams: ['field', 'value'],
  gherkinVerb: 'When',
  stepPattern: 'I fill the {string} field with {string}',
  example: 'When I fill the "Email" field with "user@example.com"',
  implementation: `When('I fill the {string} field with {string}', async function(this: CustomWorld, field: string, value: string) {
  const textbox = this.page.getByRole('textbox', { name: field });
  const count = await textbox.count();
  await (count > 0 ? textbox.first() : this.page.getByLabel(field).first()).fill(value);
});`,
};

export default template;
