import { requestDeadline } from "@hypit/runtime-kit";
import type { AsyncEndpoint, EndpointCredential, EndpointInvocationContext, EndpointOutcome, ImmediateEndpointHandler } from "@hypit/endpoint-kit";
import { EndpointResponseError, EndpointServiceError, EndpointTransportError, defineEndpointPackage, pollAgainOrFail, transport, wakeAfter } from "@hypit/endpoint-kit";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef, ResourceStore } from "@hypit/runtime";
import { openRouterRouteForCapability, openRouterRoutes } from "./routes.js";
import { OpenRouterHttpError, OpenRouterServiceError, openRouterJobFailure } from "./errors.js";

export const openRouterProviderModuleRef = { name: "@hypit/provider-openrouter", version: "1" } as const;

export type CreateOpenRouterProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly baseUrl?: string;
  readonly apiKey?: CredentialRef;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: import("@hypit/endpoint-kit").EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Publish a referenced Resource at a URL the service can fetch; replaces inline data URLs. */
  readonly publicAssetUrl?: (artifact: BlobRef, artifacts: ResourceStore, fields?: Readonly<Record<string, string | number | boolean>>) => Promise<string>;
};

type Handle = {
  readonly contract: "hypit.openrouter-video@1";
  readonly jobId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly urls?: readonly string[];
};

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function apiBaseUrl(value: string): string {
  let trimmed = value.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  assert(trimmed.length > 0, "OpenRouter base URL is empty");
  return trimmed;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  assert(typeof value === "string" && value.length > 0, "OpenRouter apiKey credential is unavailable; store an OpenRouter API key for this Endpoint");
  return value;
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(error: unknown): EndpointOutcome {
  return { status: "failed", failure: { code: error instanceof EndpointServiceError ? error.code : "OPENROUTER_ERROR", message: failureMessage(error) } };
}

class OpenRouterClient {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  async json(path: string, key: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const deadline = requestDeadline(this.timeout, () => new EndpointTransportError("OpenRouter request timed out"));
    try {
      const response = await transport(deadline.wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init, signal: deadline.signal, headers: { authorization: `Bearer ${key}`, "x-title": "Hypit", ...(init.headers ?? {}) },
      })));
      const text = await transport(deadline.wait(response.text()));
      if (!response.ok) {
        const input = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        throw new OpenRouterHttpError(response.status, text, {
          method: init.method ?? "GET", path, ...(typeof input?.model === "string" ? { model: input.model } : {}),
        });
      }
      try { return object(text.length === 0 ? {} : JSON.parse(text), "OpenRouter response"); } catch { throw new EndpointResponseError(`OpenRouter returned invalid JSON (${response.status})`); }
    } finally { deadline.finish(); }
  }
  /** Video content is served by the API itself and needs the account key. */
  async download(url: string, key: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const target = new URL(url, `${this.baseUrl}/`);
    const deadline = requestDeadline(this.timeout);
    try {
      const sameOrigin = target.origin === new URL(this.baseUrl).origin;
      const response = await deadline.wait(this.fetcher(target, {
        signal: deadline.signal, ...(sameOrigin ? { headers: { authorization: `Bearer ${key}` } } : {}),
      }));
      if (!response.ok) throw new Error(`OpenRouter video content returned HTTP ${response.status}`);
      return { bytes: new Uint8Array(await deadline.wait(response.arrayBuffer())), mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "video/mp4" };
    } finally { deadline.finish(); }
  }
}

function resolverFor(context: EndpointInvocationContext, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact, fields) => {
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      if (publicAssetUrl !== undefined) return await publicAssetUrl(artifact, context.resources, fields);
      // OpenRouter documents data URLs for image references; reference videos travel by public URL.
      const kind = artifact.mediaType.split("/", 1)[0];
      assert(kind === "image" || kind === "audio",
        `OpenRouter accepts ${artifact.mediaType} references only by public URL; configure publicAssetUrl for this Endpoint`);
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size, `Reference Resource ${artifact.resource} is unavailable or has changed`);
      return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

async function compileBody(context: EndpointInvocationContext, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]) {
  const route = openRouterRouteForCapability(context.need.capability);
  assert(route !== undefined, "OpenRouter does not implement this exact capability");
  const request = route.prepare(context.need.constraints);
  await context.reportProgress?.({ phase: `Preparing OpenRouter request: ${request.model}` });
  try {
    return { route, model: request.model, body: await request.compile(resolverFor(context, publicAssetUrl)) };
  } catch (error) {
    throw new OpenRouterServiceError(error instanceof EndpointServiceError ? error.code : "OPENROUTER_ERROR",
      `OpenRouter request preparation failed; model=${request.model}; generation not submitted: ${failureMessage(error)}`);
  }
}

function imageEndpoint(client: OpenRouterClient, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]): ImmediateEndpointHandler {
  return async (context) => {
    const { route, model, body } = await compileBody(context, publicAssetUrl);
    await context.reportProgress?.({ phase: `Generating image with OpenRouter: ${model}` });
    const response = await client.json("/images", apiKey(context.credentials), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert(Array.isArray(response.data) && response.data.length > 0, `OpenRouter ${model} returned no image`);
    const blobs: BlobRef[] = [];
    for (const [index, item] of response.data.entries()) {
      const image = object(item, `OpenRouter image ${index + 1}`);
      assert(typeof image.b64_json === "string" && image.b64_json.length > 0, `OpenRouter image ${index + 1} has no data`);
      const mediaType = typeof image.media_type === "string" ? image.media_type : "image/png";
      blobs.push(await context.resources.put(new Uint8Array(Buffer.from(image.b64_json, "base64")), mediaType));
    }
    return { value: route.packageResult(blobs) };
  };
}

function videoEndpoint(client: OpenRouterClient, pollIntervalMs: number, maxOperationMs: number, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]): AsyncEndpoint {
  return {
    async start(context) {
      try {
        const { route, model, body } = await compileBody(context, publicAssetUrl);
        await context.reportProgress?.({ phase: `Submitting OpenRouter video: ${model}` });
        const response = await client.json("/videos", apiKey(context.credentials), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        assert(typeof response.id === "string" && response.id.length > 0, "OpenRouter response has no video job id");
        const handle: Handle = { contract: "hypit.openrouter-video@1", jobId: response.id, route: route.key, startedAt: Date.now() };
        const receipt = { id: handle.jobId };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async poll(context) {
      try {
        const handle = object(context.handle, "OpenRouter handle") as unknown as Handle;
        const route = openRouterRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.contract === "hypit.openrouter-video@1" && handle.route === route.key, "OpenRouter handle is invalid");
        const receipt = { id: handle.jobId };
        if (Date.now() - handle.startedAt > maxOperationMs) {
          return { status: "failed", receipt, failure: { code: "OPENROUTER_OPERATION_TIMEOUT", message: `OpenRouter video job ${handle.jobId} exceeded this Provider's operationTimeoutMs (${maxOperationMs}); remote outcome is unknown` } };
        }
        const job = await client.json(`/videos/${encodeURIComponent(handle.jobId)}`, apiKey(context.credentials));
        const status = String(job.status);
        if (status === "pending" || status === "in_progress") {
          return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status }), receipt };
        }
        const rejected = openRouterJobFailure(job, handle.jobId);
        if (rejected !== undefined) return { ...failure(rejected), receipt };
        assert(status === "completed", `OpenRouter returned unknown video job status ${status}`);
        assert(Array.isArray(job.unsigned_urls) && job.unsigned_urls.length > 0, "OpenRouter video job completed without output");
        const urls = job.unsigned_urls.map((url, index) => {
          assert(typeof url === "string" && url.length > 0, `OpenRouter video output ${index + 1} has no URL`);
          return url;
        });
        return { status: "ready", handle: canonicalize({ ...handle, urls }), receipt };
      } catch (error) {
        return pollAgainOrFail(error, { handle: context.handle, pollIntervalMs, failure });
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "OpenRouter handle") as unknown as Handle;
        const route = openRouterRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.route === route.key && Array.isArray(handle.urls), "OpenRouter collection route differs");
        await context.reportProgress?.({ phase: "Receiving generated video" });
        const blobs: BlobRef[] = [];
        for (const url of handle.urls) {
          const downloaded = await client.download(url, apiKey(context.credentials));
          blobs.push(await context.resources.put(downloaded.bytes, downloaded.mediaType));
        }
        return { status: "completed", result: { value: route.packageResult(blobs) }, receipt: { id: handle.jobId } };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createOpenRouterProvider(options: CreateOpenRouterProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30 * 60_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, operationTimeoutMs })) {
    assert(Number.isSafeInteger(value) && value > 0, `OpenRouter ${name} must be a positive integer`);
  }
  const client = new OpenRouterClient(apiBaseUrl(options.baseUrl ?? "https://openrouter.ai/api/v1"), requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const images = imageEndpoint(client, options.publicAssetUrl);
  const videos = videoEndpoint(client, options.pollIntervalMs ?? 10_000, operationTimeoutMs, options.publicAssetUrl);
  return defineEndpointPackage({
    module: openRouterProviderModuleRef, facet: "gateway", instance: options.instance ?? "openrouter.default", pool: options.pool ?? options.instance ?? "openrouter.default",
    pricing: { kind: "page", url: "https://openrouter.ai/models" },
    credentials: { apiKey: options.apiKey ?? credentialRef("os", "openrouter.api-key") },
    credentialInputs: { apiKey: { label: "OpenRouter API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 4,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: openRouterRoutes.map((route) => route.result === "image"
      ? { capability: route.capability, returns: route.returns, lifecycle: "immediate" as const, handler: images, capacity: route.capability.name, supports: route.supports }
      : { capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const, endpoint: videos, capacity: route.capability.name, supports: route.supports }),
  });
}
