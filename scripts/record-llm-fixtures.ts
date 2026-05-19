/*
Run manually:
  OPENROUTER_API_KEY=... pnpm exec ts-node scripts/record-llm-fixtures.ts

If you prefer a loader-based runner:
  OPENROUTER_API_KEY=... node --import ts-node/register scripts/record-llm-fixtures.ts
*/

import fs from 'fs/promises';
import path from 'path';
import type OpenAI from 'openai';
import {
  STEP_SHARED_RULES,
  buildOpenAIClient,
  extractRequiredStepCoverage,
  extractStepPatterns,
  stripMarkdownJson,
} from '../packages/backend/src/worker/generator';
import type { ActionLog, LLMConfig } from '../packages/backend/src/types';

const FIXTURES_DIR = path.resolve(__dirname, '../packages/backend/src/worker/__fixtures__');
const COMMON_OUTPUT = path.join(FIXTURES_DIR, 'pass2-common-steps.json');
const FEATURE_OUTPUT = path.join(FIXTURES_DIR, 'pass2-feature-steps.json');
const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-5';

const actionLog: ActionLog = {
  jobHash: 'fixture-recording',
  targetUrl: 'https://demo.odoo.com',
  inferredJourneys: ['Sales order creation'],
  entries: [
    {
      id: '1',
      type: 'goto',
      url: 'https://demo.odoo.com',
      timestamp: Date.now(),
    },
    {
      id: '2',
      type: 'click',
      selector: '[data-menu-xmlid="sale.sale_menu_root"]',
      selectorStrategy: 'css',
      text: 'Sales',
      timestamp: Date.now(),
    },
    {
      id: '3',
      type: 'click',
      selector: 'button:has-text("New")',
      selectorStrategy: 'text',
      text: 'New',
      timestamp: Date.now(),
    },
    {
      id: '4',
      type: 'fill',
      selector: 'input[placeholder="Search..."]',
      selectorStrategy: 'css',
      value: 'Azure Interior',
      timestamp: Date.now(),
    },
    {
      id: '5',
      type: 'assert',
      selector: '.o_list_view',
      selectorStrategy: 'css',
      text: 'Quotations',
      timestamp: Date.now(),
    },
  ],
};

const featureFiles = [{
  filename: '01_sales.feature',
  content: [
    'Feature: Sales',
    '  Scenario: View quotations list',
    '    Given I am on the Sales page',
    '    Then I see "Quotations"',
    '',
    '  Scenario: Start a new quotation',
    '    Given I am on the Sales page',
    '    When I click the "New" button',
    '    Then I should see "New" in the page header',
  ].join('\n'),
}];

async function llmCall(
  client: OpenAI,
  llm: LLMConfig,
  system: string,
  user: string
): Promise<Array<{ filename: string; content: string }>> {
  let raw = '';

  try {
    const response = await client.chat.completions.create({
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });
    raw = response.choices[0]?.message?.content ?? '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/response_format|json_object/i.test(message)) {
      throw error;
    }

    const response = await client.chat.completions.create({
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    raw = response.choices[0]?.message?.content ?? '';
  }

  if (!raw) {
    throw new Error('LLM returned empty content');
  }

  const parsed = JSON.parse(stripMarkdownJson(raw)) as { files?: Array<{ filename: string; content: string }> };
  if (!Array.isArray(parsed.files)) {
    throw new Error('LLM returned unexpected structure');
  }
  return parsed.files;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error('Missing OPENROUTER_API_KEY or OPENAI_API_KEY');
    process.exit(1);
  }

  const llm: LLMConfig = {
    provider: 'openrouter',
    apiKey,
    model,
  };
  const client = buildOpenAIClient(llm);
  const featuresText = featureFiles.map((f) => `=== ${f.filename} ===\n${f.content}`).join('\n\n');

  const pass2aSystem = `You are a Playwright + Cucumber.js step definition writer.
${STEP_SHARED_RULES}

Your task: generate ONLY "common.steps.ts" containing every step that appears in more than one feature file, OR that is a navigation/setup step (login, navigation menus, page loads).
Do NOT include scenario-specific assertion steps in common.steps.ts.
Return a JSON object: { "files": [{ "filename": "common.steps.ts", "content": "..." }] }`;

  const pass2aUser = `Target URL: ${actionLog.targetUrl}
Actions recorded:
${actionLog.entries.map((e) => `[${e.type}] selector: ${e.selector ?? 'N/A'} value: ${e.value ?? 'N/A'}`).join('\n')}

Feature files:
${featuresText}`;

  const commonFiles = await llmCall(client, llm, pass2aSystem, pass2aUser);
  const commonSteps = commonFiles[0];
  const commonKeys = extractStepPatterns(commonSteps.content);
  const requiredPatterns = extractRequiredStepCoverage(featureFiles);
  const commonPatterns = new Set([...commonKeys].map((key) => key.slice(key.indexOf(':') + 1)));

  const requiredLines = requiredPatterns
    .filter(({ pattern }) => !commonPatterns.has(pattern))
    .map(({ keyword, pattern }) => `- ${keyword}('${pattern}')`)
    .join('\n');

  const signatureLines = [...commonKeys]
    .map((key) => `- ${key.slice(0, key.indexOf(':'))}('${key.slice(key.indexOf(':') + 1)}')`)
    .join('\n');

  const pass2bSystem = `You are a Playwright + Cucumber.js step definition writer.
${STEP_SHARED_RULES}

These step signatures are already defined in common.steps.ts.
You MUST NOT redeclare any of them in feature-specific files.
Cucumber loads common.steps.ts automatically — duplicates cause an Ambiguous error.

=== Reserved signatures (DO NOT redeclare) ===
${signatureLines || '(none)'}

=== Required patterns — YOU MUST implement ALL of these EXACTLY as written ===
Pattern strings must match character-for-character (word order, "button" vs "link", etc.).
${requiredLines || '(all covered by common.steps.ts)'}

Return a JSON object: { "files": [{ "filename": "XX_name.steps.ts", "content": "..." }, ...] }
Do NOT include common.steps.ts in the output — only feature-specific files.`;

  const pass2bUser = `Target URL: ${actionLog.targetUrl}
Actions recorded:
${actionLog.entries.map((e) => `[${e.type}] selector: ${e.selector ?? 'N/A'} value: ${e.value ?? 'N/A'}`).join('\n')}

Feature files to implement (one .steps.ts per .feature file):
${featuresText}`;

  const featureStepFiles = await llmCall(client, llm, pass2bSystem, pass2bUser);
  const recordedAt = new Date().toISOString();

  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  await fs.writeFile(COMMON_OUTPUT, JSON.stringify({
    recorded_at: recordedAt,
    model,
    files: commonFiles,
  }, null, 2) + '\n');
  await fs.writeFile(FEATURE_OUTPUT, JSON.stringify({
    recorded_at: recordedAt,
    model,
    files: featureStepFiles,
  }, null, 2) + '\n');

  // eslint-disable-next-line no-console
  console.log(`Wrote ${commonFiles.length + featureStepFiles.length} file(s) to ${FIXTURES_DIR}`);
}

void main();
