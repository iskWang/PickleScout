export interface Template {
  templateId: string;
  requiredParams: string[];
  gherkinVerb: 'Given' | 'When' | 'Then';
  stepPattern: string;
  example: string;
  implementation: string;
}

import navigateToUrl from './navigate_to_url';
import clickByText from './click_by_text';
import clickByRole from './click_by_role';
import clickByLabel from './click_by_label';
import fillByLabel from './fill_by_label';
import selectOption from './select_option';
import waitForLoad from './wait_for_load';
import assertVisible from './assert_visible';
import assertNotVisible from './assert_not_visible';
import assertUrlContains from './assert_url_contains';

export const TEMPLATE_CATALOG: Template[] = [
  navigateToUrl,
  clickByText,
  clickByRole,
  clickByLabel,
  fillByLabel,
  selectOption,
  waitForLoad,
  assertVisible,
  assertNotVisible,
  assertUrlContains,
];
