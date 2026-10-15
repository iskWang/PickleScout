# Language Policy

## Documentation

- Write all technical documentation in English, including README, PRD, ADR, architecture documents, implementation plans, and runbooks.
- Do not maintain duplicate documentation in multiple languages unless explicitly requested.
- Preserve the original language of existing documents unless translation is explicitly requested.

## Agent Communication

- Respond in the user's preferred language, including explanations, implementation plans, progress updates, code reviews, and final summaries.
- If no language preference is specified, use the language of the user's latest message.
- Preserve established English technical terminology when communicating in other languages. Avoid unnecessary literal translations.

## Code and GitHub

- Use English for code identifiers, comments, logs, error messages, and API descriptions.
- Use English for commit messages, pull request titles and descriptions, and GitHub issues.
- Keep code examples and command-line instructions consistent with the project's actual implementation.

## Language Priority

- Explicit user instructions take precedence over these defaults.
- The language used for agent communication must not affect the language of generated technical documentation or code unless explicitly requested.
