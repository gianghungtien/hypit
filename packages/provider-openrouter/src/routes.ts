import {
  compileWireRequest,
  selectWireModelForRequest,
  generationTypes,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
} from "@hypit/generation";
import type { GenerationArtifactUrlResolver, GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, StoredValue, TypeRef } from "@hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/endpoint-kit";
import { openRouterMappings } from "./mapping.js";

export type OpenRouterPreparedRequest = {
  readonly model: string;
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type OpenRouterRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => OpenRouterPreparedRequest;
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/**
 * OpenRouter's published ranges per model (`GET /api/v1/videos/models` and `/api/v1/images/models`)
 * that are narrower than the Hypit Model's vocabulary. Values outside them are refused before any
 * reference is resolved, rather than clamped.
 */
const SEEDANCE_RESOLUTIONS: Readonly<Record<string, readonly string[]>> = {
  "seedance-2": ["480p", "720p", "1080p", "4k"],
  "seedance-2-fast": ["480p", "720p"],
  "seedance-2-mini": ["480p", "720p"],
  "seedance-2.5": ["480p", "720p"],
};
const SEEDANCE_MAX_DURATION: Readonly<Record<string, number>> = {
  "seedance-2": 15, "seedance-2-fast": 15, "seedance-2-mini": 15, "seedance-2.5": 30,
};
const IMAGE_RATIOS: Readonly<Record<string, readonly string[]>> = {
  "gpt-image-2": ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"],
  "nano-banana-2": ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
  "nano-banana-pro": ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
};
const SEEDREAM_RESOLUTION: Readonly<Record<string, string>> = { basic: "2K", ultra: "4K" };

function rejection(mapping: GenerationWireMapping, request: GenerationRequest): string | undefined {
  const { name } = mapping.capability;
  const model = mapping.routes[0]!.model;
  const ratio = scalar(request, "aspectRatio");
  const resolution = scalar(request, "resolution");
  if (mapping.capability.module.name === "@hypit/seedance") {
    if (ratio === "adaptive") return `OpenRouter ${model} takes an explicit aspect ratio, not adaptive`;
    if (!SEEDANCE_RESOLUTIONS[name]!.includes(String(resolution))) {
      return `OpenRouter ${model} renders ${SEEDANCE_RESOLUTIONS[name]!.join(", ")}, not ${String(resolution)}`;
    }
    const duration = scalar(request, "duration");
    if (typeof duration !== "number" || duration < 4 || duration > SEEDANCE_MAX_DURATION[name]!) {
      return `OpenRouter ${model} renders 4 to ${SEEDANCE_MAX_DURATION[name]} seconds, not ${String(duration)}`;
    }
    if (scalar(request, "webSearch") === true) return `OpenRouter ${model} has no web search option`;
    return undefined;
  }
  const ratios = IMAGE_RATIOS[name];
  if (ratios !== undefined && !ratios.includes(String(ratio))) {
    return `OpenRouter ${model} does not render aspect ratio ${String(ratio)}`;
  }
  if (name === "gpt-image-2" && scalar(request, "background") === "transparent") {
    return "OpenRouter openai/gpt-image-2 accepts background auto or opaque, not transparent";
  }
  if (name === "seedream-5-lite" && SEEDREAM_RESOLUTION[String(scalar(request, "quality"))] === undefined) {
    return `OpenRouter ${model} renders 2K (basic) or 4K (ultra), not quality ${String(scalar(request, "quality"))}`;
  }
  return undefined;
}

function imagePart(url: unknown) { return { type: "image_url", image_url: { url } }; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

/** Reshape the flat compiled fields into OpenRouter's request body. */
function body(mapping: GenerationWireMapping, model: string, input: Record<string, unknown>): Record<string, unknown> {
  const { name } = mapping.capability;
  const {
    reference_images: images, reference_videos: videos, reference_audios: audios,
    first_frame: firstFrame, last_frame: lastFrame, web_search: _webSearch, nsfw_check: _nsfwCheck, ...rest
  } = input;
  const out: Record<string, unknown> = { model, ...rest };
  const references = [
    ...list(images).map(imagePart),
    ...list(videos).map((url) => ({ type: "video_url", video_url: { url } })),
    ...list(audios).map((url) => ({ type: "audio_url", audio_url: { url } })),
  ];
  if (references.length > 0) out.input_references = references;
  const frames = [
    ...(firstFrame === undefined ? [] : [{ ...imagePart(firstFrame), frame_type: "first_frame" }]),
    ...(lastFrame === undefined ? [] : [{ ...imagePart(lastFrame), frame_type: "last_frame" }]),
  ];
  if (frames.length > 0) out.frame_images = frames;
  if (name === "seedance-2" && out.resolution === "4k") out.resolution = "4K";
  if (mapping.capability.module.name === "@hypit/nano-banana" && out.output_format === "jpg") out.output_format = "jpeg";
  if (name === "seedream-5-lite") {
    out.resolution = SEEDREAM_RESOLUTION[String(out.quality)];
    delete out.quality;
  }
  if (mapping.result === "image") out.n = 1;
  return out;
}

function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}

export const openRouterRoutes: readonly OpenRouterRoute[] = openRouterMappings.map((mapping) => ({
  ...mapping,
  key: capabilityKey(mapping.capability),
  returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
  supports: (request) => {
    const reason = rejection(mapping, request.constraints as unknown as GenerationRequest);
    return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
  },
  prepare: (constraints) => {
    const request = constraints as unknown as GenerationRequest;
    const reason = rejection(mapping, request);
    if (reason !== undefined) throw new Error(reason);
    const model = selectWireModelForRequest(mapping, request);
    return {
      model,
      compile: async (resolve) =>
        body(mapping, model, (await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>),
    };
  },
  packageResult: (artifacts) => ({
    kind: "inline",
    value: canonicalize(mapping.result === "image"
      ? sealGeneratedImageSet({ images: artifacts })
      : sealGeneratedVideoSet({ videos: artifacts })),
  }),
}));

const byCapability = new Map(openRouterRoutes.map((route) => [route.key, route]));

export function openRouterRouteForCapability(capability: CapabilityRef): OpenRouterRoute | undefined {
  return byCapability.get(capabilityKey(capability));
}
