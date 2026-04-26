import path from 'path';

const VALID_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_SESSION_NAME = 'default';
export const MAINTENANCE_SESSION_NAME = 'maintenance';
export const KNOWN_SESSION_NAMES = new Set([DEFAULT_SESSION_NAME, MAINTENANCE_SESSION_NAME]);

/**
 * Resolve the path for an IPC script result file.
 *
 * requestId is validated strictly: only alphanumerics, underscores, and
 * hyphens are allowed. Anything containing path separators, dots, or other
 * special characters is routed to a fixed fallback to prevent path traversal.
 *
 * sessionName is checked against the known session allowlist. Unknown values
 * fall back to the default session so no new directories are created.
 */
export function resolveIpcResultPath(outputDir: string, sessionName: string, requestId: string): string {
  if (!VALID_REQUEST_ID_RE.test(requestId)) {
    return path.join(outputDir, '_script_result_invalid.json');
  }
  const safeSession = KNOWN_SESSION_NAMES.has(sessionName) ? sessionName : DEFAULT_SESSION_NAME;
  return path.join(outputDir, safeSession, `${requestId}.json`);
}
