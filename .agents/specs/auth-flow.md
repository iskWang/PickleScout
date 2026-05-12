# Auth Flow Specification

## Scope
- MVP supports **Form-based authentication** only.
- No OAuth, SSO, MFA, or SAML.

## AuthConfig Schema
```typescript
interface AuthConfig {
  type: 'form';
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector?: string;      // Optional; LLM infers when omitted
  passwordSelector?: string;
  submitSelector?: string;
}
```

## Implementation Strategy
1. **Detection**: LLM agent detects username/password fields if selectors are missing.
2. **Execution**: Stagehand performs the login flow at the start of exploration.
3. **Session Persistence**: Authentication state (cookies/storage) is captured.
4. **Injection**: Generated tests use the captured state to bypass the login UI where possible, or follow the same form-login steps.

## Security
- Credentials follow the same storage and redaction policy as API keys.
- Redact `auth.password` from all logs.
