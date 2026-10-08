/** Structured JSON logs, one object per line. Registered secrets are redacted from every line. */
const secrets: string[] = [];
export function registerSecrets(...vals: (string | undefined)[]) { for (const v of vals) if (v && v.length >= 6) secrets.push(v); }
export function redact(s: string) { let out = s; for (const v of secrets) out = out.split(v).join("***"); return out; }
export function log(event: string, data: Record<string, unknown> = {}) {
  process.stdout.write(redact(JSON.stringify({ ts: new Date().toISOString(), event, ...data })) + "\n");
}
export function logError(event: string, err: unknown, data: Record<string, unknown> = {}) {
  process.stderr.write(redact(JSON.stringify({ ts: new Date().toISOString(), level: "error", event, error: err instanceof Error ? err.message : String(err), ...data })) + "\n");
}
