import type { Template } from './index';

const template: Template = {
  templateId: 'click_by_role',
  requiredParams: ['name', 'role'],
  gherkinVerb: 'When',
  stepPattern: 'I click the {string} {string}',
  example: 'When I click the "Submit" button',
  implementation: `When('I click the {string} {string}', async function(this: CustomWorld, name: string, role: string) {
  const validRoles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'] as const;
  type ValidRole = typeof validRoles[number];
  const r = validRoles.includes(role as ValidRole) ? (role as ValidRole) : 'button';
  await this.page.getByRole(r, { name }).click();
});`,
};

export default template;
