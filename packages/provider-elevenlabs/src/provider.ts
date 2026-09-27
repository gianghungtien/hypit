import { requestDeadline } from "@hypit/runtime-kit";
import type { EndpointCredential, EndpointRequest, EndpointSupport, ImmediateEndpointHandler } from "@hypit/endpoint-kit";
import { EndpointHttpError, EndpointResponseError, EndpointTransportError, defineEndpointPackage, transport } from "@hypit/endpoint-kit";
import { generationTypes, sealGeneratedAudioSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef } from "@hypit/runtime";

export const elevenLabsProviderModuleRef = { name: "@hypit/provider-elevenlabs", version: "1" } as const;

const VOICE_DESIGN = { module: { name: "@hypit/elevenlabs-speech", version: "1" }, name: "eleven_ttv_v3" } as const;

export type CreateElevenLabsProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly baseUrl?: string;
  readonly apiKey?: CredentialRef;
  readonly defaultConcurrency?: number;
  /** ElevenLabs `output_format` query value, `codec_sample_rate_bitrate`. */
  readonly outputFormat?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  assert(typeof value === "string" && value.length > 0, "ElevenLabs apiKey credential is unavailable; store an ElevenLabs API key for this Endpoint");
  return value;
}

/** The two texts ElevenLabs Voice Design requires, with its documented character bounds. */
function voiceDesignInput(constraints: CanonicalValue): { readonly text: string; readonly voiceDescription: string } {
  const request = constraints as unknown as GenerationRequest;
  const text = request.ports.text?.[0];
  const voiceDescription = request.ports.voiceDescription?.[0];
  assert(typeof text === "string" && typeof voiceDescription === "string", "ElevenLabs Voice Design needs text and voiceDescription");
  return { text, voiceDescription };
}
function rejection(constraints: CanonicalValue): string | undefined {
  let input;
  try { input = voiceDesignInput(constraints); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (input.text.length < 100 || input.text.length > 1000) return `ElevenLabs Voice Design speaks 100 to 1000 characters, not ${input.text.length}`;
  if (input.voiceDescription.length < 20 || input.voiceDescription.length > 1000) {
    return `ElevenLabs Voice Design takes a 20 to 1000 character description, not ${input.voiceDescription.length}`;
  }
  return undefined;
}
function supports(request: EndpointRequest): EndpointSupport {
  const reason = rejection(request.constraints);
  return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
}

/** ElevenLabs errors carry `detail` as a `{ status, message }` object or a validation array. */
class ElevenLabsHttpError extends EndpointHttpError {
  constructor(status: number, bodyText: string) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON gateway failures still have HTTP evidence. */ }
    const detail = body?.detail;
    const code = typeof record(detail)?.status === "string" ? `ELEVENLABS_${String(record(detail)!.status).toUpperCase()}` : "ELEVENLABS_HTTP_ERROR";
    const reason = typeof record(detail)?.message === "string" ? String(record(detail)!.message)
      : Array.isArray(detail) ? detail.map((item) => String(record(item)?.msg ?? item)).join("; ")
      : body === undefined ? bodyText.slice(0, 2000) : undefined;
    super(code, `ElevenLabs HTTP ${status}; ${code}; POST /v1/text-to-voice/design${reason === undefined || reason.length === 0 ? "" : `: ${reason}`}`, status);
  }
}

function voiceDesignEndpoint(baseUrl: string, outputFormat: string, timeout: number, fetcher: typeof globalThis.fetch): ImmediateEndpointHandler {
  return async (context) => {
    const reason = rejection(context.need.constraints);
    if (reason !== undefined) throw new Error(reason);
    const input = voiceDesignInput(context.need.constraints);
    await context.reportProgress?.({ phase: "Designing voice with ElevenLabs" });
    const deadline = requestDeadline(timeout, () => new EndpointTransportError("ElevenLabs request timed out"));
    let text: string;
    try {
      const response = await transport(deadline.wait(fetcher(`${baseUrl}/v1/text-to-voice/design?output_format=${encodeURIComponent(outputFormat)}`, {
        method: "POST",
        signal: deadline.signal,
        headers: { "xi-api-key": apiKey(context.credentials), "content-type": "application/json" },
        body: JSON.stringify({ voice_description: input.voiceDescription, text: input.text, model_id: VOICE_DESIGN.name }),
      })));
      text = await transport(deadline.wait(response.text()));
      if (!response.ok) throw new ElevenLabsHttpError(response.status, text);
    } finally { deadline.finish(); }
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(text)); } catch { throw new EndpointResponseError("ElevenLabs returned invalid JSON"); }
    const previews = body?.previews;
    assert(Array.isArray(previews) && previews.length > 0, "ElevenLabs Voice Design returned no previews");
    const audios: BlobRef[] = [];
    for (const [index, item] of previews.entries()) {
      const preview = record(item);
      assert(typeof preview?.audio_base_64 === "string" && preview.audio_base_64.length > 0, `ElevenLabs preview ${index + 1} has no audio`);
      const mediaType = typeof preview.media_type === "string" && preview.media_type.includes("/") ? preview.media_type : "audio/mpeg";
      audios.push(await context.resources.put(new Uint8Array(Buffer.from(preview.audio_base_64, "base64")), mediaType));
    }
    return { value: { kind: "inline", value: canonicalize(sealGeneratedAudioSet({ audios })) } };
  };
}

export function createElevenLabsProvider(options: CreateElevenLabsProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  assert(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0, "ElevenLabs requestTimeoutMs must be a positive integer");
  let baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").trim();
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const handler = voiceDesignEndpoint(baseUrl, options.outputFormat ?? "mp3_44100_128", requestTimeoutMs, options.fetch ?? globalThis.fetch);
  return defineEndpointPackage({
    module: elevenLabsProviderModuleRef, facet: "gateway", instance: options.instance ?? "elevenlabs.default", pool: options.pool ?? options.instance ?? "elevenlabs.default",
    pricing: { kind: "page", url: "https://elevenlabs.io/pricing/api" },
    credentials: { apiKey: options.apiKey ?? credentialRef("os", "elevenlabs.api-key") },
    credentialInputs: { apiKey: { label: "ElevenLabs API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 2,
    capabilities: [{
      capability: VOICE_DESIGN, returns: generationTypes.audioSet, lifecycle: "immediate" as const, handler, capacity: VOICE_DESIGN.name, supports,
    }],
  });
}
