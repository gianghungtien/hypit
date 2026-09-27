import type { ModuleRef } from "@hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const SEEDREAM: ModuleRef = { name: "@hypit/seedream", version: "1" };
const GPT_IMAGE: ModuleRef = { name: "@hypit/gpt-image", version: "1" };
const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };

/**
 * OpenRouter model slugs and the fields each request compiles to before `routes.ts` reshapes media
 * into OpenRouter's nested `input_references` and `frame_images` parts. The flat `reference_*`,
 * `first_frame` and `last_frame` names below are intermediate, never sent. `personReference` is
 * accepted on Seedance visual references and not transmitted: OpenRouter has no field for it.
 */
const seedanceFields = {
  prompt: { as: "value", field: "prompt" },
  aspectRatio: { as: "value", field: "aspect_ratio" },
  duration: { as: "value", field: "duration" },
  resolution: { as: "value", field: "resolution" },
  firstFrame: { as: "url", field: "first_frame", resourceFields: ["personReference"] },
  lastFrame: { as: "url", field: "last_frame", resourceFields: ["personReference"] },
  referenceImage: { as: "urlArray", field: "reference_images", resourceFields: ["personReference"] },
  referenceVideo: { as: "urlArray", field: "reference_videos", resourceFields: ["personReference"] },
  referenceAudio: { as: "urlArray", field: "reference_audios" },
  generateAudio: { as: "value", field: "generate_audio" },
  webSearch: { as: "value", field: "web_search" },
} as const satisfies GenerationWireMapping["fields"];

const seedance = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: SEEDANCE, name }, result: "video", routes: [{ model }], fields: seedanceFields,
});

const nanoBanana = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: NANO_BANANA, name }, result: "image", routes: [{ model }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    images: { as: "urlArray", field: "reference_images" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    resolution: { as: "value", field: "resolution" },
    outputFormat: { as: "value", field: "output_format" },
  },
});

export const openRouterMappings: readonly GenerationWireMapping[] = [
  seedance("seedance-2", "bytedance/seedance-2.0"),
  seedance("seedance-2-fast", "bytedance/seedance-2.0-fast"),
  seedance("seedance-2-mini", "bytedance/seedance-2.0-mini"),
  seedance("seedance-2.5", "bytedance/seedance-2.5"),
  {
    capability: { module: GPT_IMAGE, name: "gpt-image-2" }, result: "image", routes: [{ model: "openai/gpt-image-2" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      background: { as: "value", field: "background" },
      images: { as: "urlArray", field: "reference_images" },
    },
  },
  nanoBanana("nano-banana-2", "google/gemini-3.1-flash-image"),
  nanoBanana("nano-banana-pro", "google/gemini-3-pro-image"),
  {
    capability: { module: SEEDREAM, name: "seedream-5-lite" }, result: "image", routes: [{ model: "bytedance-seed/seedream-5-0-lite" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      quality: { as: "value", field: "quality" },
      outputFormat: { as: "value", field: "output_format" },
      nsfwCheck: { as: "value", field: "nsfw_check" },
      images: { as: "urlArray", field: "reference_images" },
    },
  },
];
