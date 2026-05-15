/**
 * URL normalization — PRD §4.3
 *
 * Rules:
 * - Trim trailing slash unless the URL is a bare host
 * - Lowercase the scheme and host
 * - Strip URL fragments (#...)
 * - Preserve querystring as-is (order significant)
 * - Reject javascript:, file:, and data: schemes
 *
 * Two URLs that normalize to the same string are treated as the same target.
 */

const FORBIDDEN_SCHEMES = ['javascript:', 'file:', 'data:'];

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();

  // Reject forbidden schemes
  for (const scheme of FORBIDDEN_SCHEMES) {
    if (trimmed.toLowerCase().startsWith(scheme)) {
      throw new Error(`Forbidden URL scheme: ${scheme}`);
    }
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  // Only http and https allowed
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }

  // Lowercase scheme + host (already done by URL parser)
  // Remove fragment
  url.hash = '';

  // Remove trailing slash from pathname unless it's just '/'
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    normalizeUrl(raw);
    return true;
  } catch {
    return false;
  }
}
