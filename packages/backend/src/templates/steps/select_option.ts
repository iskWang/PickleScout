import type { Template } from './index';

const template: Template = {
  templateId: 'select_option',
  requiredParams: ['option', 'dropdown'],
  gherkinVerb: 'When',
  stepPattern: 'I select {string} from the {string} dropdown',
  example: 'When I select "Active" from the "Status" dropdown',
  implementation: `When('I select {string} from the {string} dropdown', async function(this: CustomWorld, option: string, dropdown: string) {
  await this.page.getByLabel(dropdown).selectOption(option);
});`,
};

export default template;
