import type { Template } from './index';

const template: Template = {
  templateId: 'navigate_to_url',
  requiredParams: ['url'],
  gherkinVerb: 'Given',
  stepPattern: 'I navigate to {string}',
  example: 'Given I navigate to "https://example.com"',
  implementation: `Given('I navigate to {string}', async function(this: CustomWorld, url: string) {
  await this.page.goto(url, { waitUntil: 'domcontentloaded' });
});`,
};

export default template;
