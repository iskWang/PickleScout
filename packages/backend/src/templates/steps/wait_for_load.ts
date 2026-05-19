import type { Template } from './index';

const template: Template = {
  templateId: 'wait_for_load',
  requiredParams: [],
  gherkinVerb: 'When',
  stepPattern: 'the page finishes loading',
  example: 'When the page finishes loading',
  implementation: `When('the page finishes loading', async function(this: CustomWorld) {
  await this.page.waitForLoadState('domcontentloaded');
});`,
};

export default template;
