# PickleScout — LLM Provider Guide

## Supported Providers

| Provider | ID | Explorer (Stagehand) | Generator (Feature/Step files) |
|---|---|---|---|
| Google Gemini | `gemini` | ✅ | ✅ via Google OpenAI-compatible endpoint |
| OpenRouter | `openrouter` | ✅ | ✅ |
| OpenAI | `openai` | ✅ | ✅ |
| Anthropic | `anthropic` | ✅ | ❌ (not OpenAI-compatible) |
| Custom (OpenAI-compatible) | `custom` | ✅ | ✅ |

## Default Model

**Provider:** OpenRouter (`openrouter`)
**Model:** `google/gemini-3.1-flash-lite-preview`

Chosen for cost-efficiency. Accessed via OpenRouter with a single API key.

> Reference: [Stagehand v3 agent docs](https://docs.stagehand.dev/v3/references/agent)

## Gemini Setup

1. Get a Google AI Studio key at [aistudio.google.com](https://aistudio.google.com)
2. Select **Google Gemini** provider in the UI
3. Enter your key — model defaults to `gemini-2.0-flash-lite`

**Explorer:** Stagehand routes `gemini` provider through `@ai-sdk/google` (`GoogleClient`).

**Generator:** Uses Google's OpenAI-compatible endpoint:
```
https://generativelanguage.googleapis.com/v1beta/openai/
```

## OpenRouter Setup

Useful for accessing many models (Claude, Gemini, GPT-4) with one key.

- Provider: `openrouter`
- Base URL: `https://openrouter.ai/api/v1`
- Model format: `provider/model-name` (e.g. `anthropic/claude-haiku-4-5`, `google/gemini-2.5-flash`)

**Note:** Explorer prefixes the model with `openai/` internally so Stagehand routes via `createOpenAI({ baseURL: openrouter })`. This is handled automatically.

## JSON Output Robustness

Some models return JSON wrapped in markdown code fences (` ```json ... ``` `). The generator strips these automatically before parsing.

## Model Recommendations

| Use case | Recommended model |
|---|---|
| Fast / low cost | `gemini-2.0-flash-lite` (Gemini) or `anthropic/claude-haiku-4-5` (OpenRouter) |
| Best quality | `gemini-2.5-pro` (Gemini) or `anthropic/claude-sonnet-4-5` (OpenRouter) |
| Offline / self-hosted | Custom provider with Ollama |
