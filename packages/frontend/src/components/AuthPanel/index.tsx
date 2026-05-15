import { useState } from 'react';
import type { AuthConfig } from '../../types';

interface Props {
  value: AuthConfig | undefined;
  onChange: (auth: AuthConfig | undefined) => void;
}

const DEFAULT_AUTH: AuthConfig = {
  type: 'form',
  loginUrl: '',
  username: '',
  password: '',
};

export default function AuthPanel({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const enabled = value !== undefined;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) onChange(undefined);
    else onChange(DEFAULT_AUTH);
  };

  const update = (patch: Partial<AuthConfig>) => {
    onChange({ ...(value ?? DEFAULT_AUTH), ...patch });
  };

  return (
    <div className="card" style={{ padding: 'var(--space-4)' }}>
      <button
        type="button"
        className={`collapsible-trigger ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        id="auth-panel-trigger"
      >
        <span className="chevron">▶</span>
        <span>🔐 Authentication</span>
        <span className="text-faint text-sm" style={{ marginLeft: 'auto' }}>
          {enabled ? 'configured' : 'optional'}
        </span>
      </button>

      {open && value && (
        <div className="collapsible-body" style={{ marginTop: 'var(--space-4)' }}>
          <div className="form-group">
            <label htmlFor="auth-login-url">Login URL</label>
            <input
              id="auth-login-url"
              type="url"
              placeholder="https://your-app.com/login"
              value={value.loginUrl}
              onChange={(e) => update({ loginUrl: e.target.value })}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="auth-username">Username</label>
              <input
                id="auth-username"
                type="text"
                placeholder="admin"
                value={value.username}
                onChange={(e) => update({ username: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                placeholder="••••••••"
                value={value.password}
                onChange={(e) => update({ password: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>

          <p className="form-hint">
            Selectors are auto-detected. Fill in below only if auto-detection fails.
          </p>

          <div className="form-row" style={{ marginTop: 'var(--space-3)' }}>
            <div className="form-group">
              <label htmlFor="auth-username-sel">Username selector <span className="text-faint">(optional)</span></label>
              <input
                id="auth-username-sel"
                type="text"
                placeholder='input[name="login"]'
                value={value.usernameSelector ?? ''}
                onChange={(e) => update({ usernameSelector: e.target.value || undefined })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="auth-password-sel">Password selector <span className="text-faint">(optional)</span></label>
              <input
                id="auth-password-sel"
                type="text"
                placeholder='input[type="password"]'
                value={value.passwordSelector ?? ''}
                onChange={(e) => update({ passwordSelector: e.target.value || undefined })}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="auth-submit-sel">Submit selector <span className="text-faint">(optional)</span></label>
            <input
              id="auth-submit-sel"
              type="text"
              placeholder='button[type="submit"]'
              value={value.submitSelector ?? ''}
              onChange={(e) => update({ submitSelector: e.target.value || undefined })}
            />
          </div>

          <div className="notice notice-warning">
            ⚠ Form-based authentication only. OAuth, SSO, and MFA are not supported.
          </div>
        </div>
      )}
    </div>
  );
}
