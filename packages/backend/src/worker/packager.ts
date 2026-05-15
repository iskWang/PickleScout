/**
 * Packager — assembles the generated Cucumber + Playwright project into a zip.
 *
 * Output structure (PRD §6.1):
 *   generated-tests/
 *   ├── features/
 *   ├── steps/
 *   ├── support/
 *   ├── cucumber.js
 *   ├── playwright.config.ts
 *   ├── package.json          ← exact-pinned versions, no ^ or ~
 *   ├── tsconfig.json
 *   ├── .github/workflows/e2e.yml
 *   ├── .env.example
 *   └── README.md
 */

import path from 'path';
import fs from 'fs/promises';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import type { ActionLog, JobState, JobSummary } from '../types';
import type { GeneratedArtifact } from './generator';
import { emitEvent } from './sse';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

// Exact-pinned versions — MUST NOT use ^ or ~ (PRD §6.4)
const PINNED_PACKAGE_JSON = {
  name: 'picklescout-generated-tests',
  version: '1.0.0',
  scripts: {
    test: 'cucumber-js',
    'test:report': 'cucumber-js --format html:reports/report.html',
  },
  dependencies: {
    '@cucumber/cucumber': '11.0.0',
    '@playwright/test': '1.50.0',
  },
  devDependencies: {
    typescript: '5.5.0',
    'ts-node': '10.9.2',
    '@types/node': '20.0.0',
  },
};

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  },
  include: ['steps/**/*', 'support/**/*'],
};

// ─── Main Packager ────────────────────────────────────────────────────────────

export async function runPackager(
  state: JobState,
  artifact: GeneratedArtifact,
  actionLog: ActionLog,
  verificationPassed: boolean,
  unhealedScenarios: number
): Promise<string> {
  const { hash } = state;

  await emitEvent(hash, { type: 'llm_log', message: 'Packaging output zip…' });

  const outputDir = path.join(STORAGE_DIR, 'outputs', hash);
  await fs.mkdir(outputDir, { recursive: true });

  const zipFilename = verificationPassed ? 'result.zip' : 'result_unverified.zip';
  const zipPath = path.join(outputDir, zipFilename);

  await buildZip(zipPath, artifact, state, actionLog);

  // Build summary
  const featureFiles = artifact.featureFiles.map((f) => f.filename);
  const summary: JobSummary = {
    scenarioCount: countScenarios(artifact.featureFiles),
    unhealedScenarios,
    featureFiles,
    verificationPassed,
    totalTokens: state.tokenUsage.promptTokens + state.tokenUsage.completionTokens,
    estimatedCostUSD: state.tokenUsage.estimatedCostUSD,
  };

  const resultUrl = `/api/jobs/${hash}/result`;

  await emitEvent(hash, {
    type: 'complete',
    resultUrl,
    summary,
  });

  return zipPath;
}

// ─── Zip Builder ──────────────────────────────────────────────────────────────

async function buildZip(
  zipPath: string,
  artifact: GeneratedArtifact,
  state: JobState,
  actionLog: ActionLog
): Promise<void> {
  const readTemplate = async (name: string): Promise<string> => {
    const templatePath = path.join(__dirname, '..', 'templates', `${name}.template`);
    return fs.readFile(templatePath, 'utf-8');
  };

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // features/
    for (const f of artifact.featureFiles) {
      archive.append(f.content, { name: `features/${f.filename}` });
    }

    // steps/
    for (const s of artifact.stepFiles) {
      archive.append(s.content, { name: `steps/${s.filename}` });
    }

    // Async file additions (templates)
    const addTemplates = async () => {
      // support/
      archive.append(await readTemplate('world.ts'), { name: 'support/world.ts' });
      archive.append(await readTemplate('hooks.ts'), { name: 'support/hooks.ts' });

      // root config files
      archive.append(await readTemplate('cucumber.js'), { name: 'cucumber.js' });
      archive.append(await readTemplate('playwright.config.ts'), { name: 'playwright.config.ts' });
      archive.append(JSON.stringify(PINNED_PACKAGE_JSON, null, 2), { name: 'package.json' });
      archive.append(JSON.stringify(TSCONFIG, null, 2), { name: 'tsconfig.json' });

      // GitHub Actions
      archive.append(await readTemplate('github-workflow.yml'), {
        name: '.github/workflows/e2e.yml',
      });

      // .env.example
      archive.append(await readTemplate('env.example'), { name: '.env.example' });

      // README
      const readme = generateReadme(state, actionLog, artifact);
      archive.append(readme, { name: 'README.md' });

      archive.finalize();
    };

    addTemplates().catch(reject);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countScenarios(featureFiles: Array<{ content: string }>): number {
  return featureFiles.reduce((total, f) => {
    const matches = f.content.match(/^\s*Scenario:/gm);
    return total + (matches?.length ?? 0);
  }, 0);
}

function generateReadme(
  state: JobState,
  actionLog: ActionLog,
  artifact: GeneratedArtifact
): string {
  const date = new Date().toISOString().split('T')[0];
  return `# PickleScout Generated Tests

> Generated by [PickleScout](https://github.com/picklescout/picklescout) on ${date}

## Target
- **URL**: ${actionLog.targetUrl}
- **Journeys**: ${actionLog.inferredJourneys.join(', ')}
- **Scenarios**: ${countScenarios(artifact.featureFiles)}

## Quick Start

\`\`\`bash
# Install dependencies (exact-pinned versions)
npm install

# Install Chromium
npx playwright install chromium --with-deps

# Copy and edit environment config
cp .env.example .env

# Run tests
npm test
\`\`\`

## Files

\`\`\`
features/     Gherkin .feature files (read-only — edit with caution)
steps/        TypeScript step definitions
support/      Cucumber World + hooks
\`\`\`

## CI/CD

A GitHub Actions workflow is included at \`.github/workflows/e2e.yml\`.
Set these repository secrets:
- \`BASE_URL\` — application base URL
- \`APP_USER\` — login username
- \`APP_PASS\` — login password

## ⚠️ Important

AI-generated tests. Review carefully before adding to CI/CD.
The system verifies that tests are syntactically valid and executable,
but does not guarantee complete business-logic coverage.

Generated with provider: ${state.llm.provider} / ${state.llm.model}
`;
}
