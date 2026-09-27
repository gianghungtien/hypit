import { EndpointHttpError, EndpointServiceError } from "@hypit/endpoint-kit";

/** OpenRouter's `{ error: { code, message, metadata } }` envelope, kept at the service boundary. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Responses may mention a signed asset URL. Keep the reason, not its access capability.
export function safeOpenRouterReason(value: string): string {
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export class OpenRouterServiceError extends EndpointServiceError {}

export class OpenRouterHttpError extends EndpointHttpError {
  constructor(status: number, bodyText: string,
    request: { readonly method: string; readonly path: string; readonly model?: string }) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON gateway failures still have HTTP evidence. */ }
    const error = record(body?.error);
    const code = error?.code === undefined ? "OPENROUTER_HTTP_ERROR" : `OPENROUTER_${String(error.code)}`;
    const reason = text(error?.message) ?? (body === undefined ? text(bodyText.slice(0, 2000)) : undefined);
    const upstream = text(record(record(error?.metadata)?.raw)?.message) ?? text(record(error?.metadata)?.raw);
    const facts = [
      `OpenRouter HTTP ${status}`, code, `${request.method} ${request.path}`,
      ...(request.model === undefined ? [] : [`model=${request.model}`]),
    ];
    const detail = [reason, upstream].filter((item): item is string => item !== undefined).join("; ");
    super(code, `${facts.join("; ")}${detail.length === 0 ? "" : `: ${safeOpenRouterReason(detail)}`}`, status);
  }
}

/** A terminal unsuccessful video job; `undefined` otherwise. */
export function openRouterJobFailure(job: Record<string, unknown>, id: string): OpenRouterServiceError | undefined {
  const status = String(job.status);
  if (status !== "failed" && status !== "cancelled" && status !== "expired") return undefined;
  const code = `OPENROUTER_VIDEO_${status.toUpperCase()}`;
  const reason = text(job.error) ?? text(record(job.error)?.message);
  return new OpenRouterServiceError(code,
    `OpenRouter video job ${id} ${status}${reason === undefined ? "" : `: ${safeOpenRouterReason(reason)}`}`);
}
