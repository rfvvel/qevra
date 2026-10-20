type Category = 'tls_certificate' | 'tls_hostname' | 'dns' | 'network' | 'timeout' | 'authentication' | 'postgresql' | 'configuration' | 'unknown';
interface Diagnostic { category: Category; code?: string; }
const codes: Readonly<Record<string, Category>> = {
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_certificate', DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_certificate', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls_certificate',
  UNABLE_TO_GET_ISSUER_CERT: 'tls_certificate', CERT_HAS_EXPIRED: 'tls_certificate',
  CERT_NOT_YET_VALID: 'tls_certificate', CERT_REVOKED: 'tls_certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname',
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns',
  ECONNREFUSED: 'network', ECONNRESET: 'network', ENETUNREACH: 'network',
  EHOSTUNREACH: 'network', EPIPE: 'network', ETIMEDOUT: 'timeout',
  DATABASE_NOT_CONFIGURED: 'configuration',
};
// Exact driver messages are recognized internally, never emitted.
const timeouts = new Set([
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Query read timeout',
]);

export function databaseDiagnostic(error: unknown): Diagnostic {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let i = 0; i < pending.length && i < 12; i++) {
    const item = pending[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof value.code === 'string') {
      const category = Object.hasOwn(codes, value.code) ? codes[value.code] : undefined;
      if (category) return { category, code: value.code };
      // SQLSTATE only; never serialize arbitrary driver fields or error objects.
      if (/^[0-9A-Z]{5}$/.test(value.code)) {
        return { category: value.code.startsWith('28') ? 'authentication' : 'postgresql', code: value.code };
      }
    }
    if (typeof value.message === 'string' && timeouts.has(value.message)) return { category: 'timeout' };
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 12));
  }
  return { category: 'unknown' };
}

// Bounded, per-source throttling prevents public health polls/worker retries flooding logs.
export function createDatabaseFailureLogger(
  write: (line: string) => void = line => console.error(line),
  now: () => number = Date.now,
) {
  const last = new Map<string, { signature: string; at: number }>();
  return (source: 'health' | 'idle_pool' | 'worker', error: unknown): void => {
    const diagnostic = databaseDiagnostic(error);
    const signature = JSON.stringify(diagnostic);
    const previous = last.get(source);
    const at = now();
    if (previous?.signature === signature && at - previous.at < 60_000) return;
    last.set(source, { signature, at });
    write(JSON.stringify({ event: 'database_operation_failed', source, ...diagnostic }));
  };
}
export const logDatabaseFailure = createDatabaseFailureLogger();
