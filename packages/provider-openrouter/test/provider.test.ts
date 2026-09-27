import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { assertMappingCoversPorts } from "@hypit/generation";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import { gptImage2Ports, gptImageEndpoints, sealGptImage2Request } from "@hypit/gpt-image";
import { nanoBananaPorts, sealNanoBananaRequest } from "@hypit/nano-banana";
import { seedancePorts, sealSeedanceRequest } from "@hypit/seedance";
import { seedream5LitePorts, sealSeedreamRequest } from "@hypit/seedream";

import { openRouterMappings } from "../src/mapping.js";
import { createOpenRouterProvider } from "../src/provider.js";
import { openRouterRouteForCapability } from "../src/routes.js";

const image: BlobRef = { kind: "blob", resource: "res_openrouter_1", size: 3, mediaType: "image/png" };
const audio: BlobRef = { kind: "blob", resource: "res_openrouter_2", size: 3, mediaType: "audio/mpeg" };
const resolve = async (artifact: BlobRef) => `https://example.test/${artifact.resource}`;
const route = (module: string, name: string) => openRouterRouteForCapability({ module: { name: module, version: "1" }, name })!;
const constraints = (request: unknown) => request as CanonicalValue;
const supported = (item: ReturnType<typeof route>, request: unknown) =>
  item.supports({ capability: item.capability, returns: item.returns, constraints: constraints(request) }).status;

test("every OpenRouter mapping covers its model's ports", () => {
  const tables = { ...seedancePorts, ...nanoBananaPorts, "seedream-5-lite": seedream5LitePorts, "gpt-image-2": gptImage2Ports };
  for (const mapping of openRouterMappings) {
    assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
  }
});

test("Seedance references and frames become OpenRouter content parts", async () => {
  const seedance = route("@hypit/seedance", "seedance-2");
  const base = { prompt: ["go"], resolution: ["4k"], aspectRatio: ["9:16"], duration: [8], generateAudio: [true], webSearch: [false] };
  const referenced = sealSeedanceRequest("seedance-2", {
    ...base,
    referenceImage: [{ role: "image", artifact: image, fields: { personReference: true } }],
    referenceAudio: [{ role: "audio", artifact: audio }],
  });
  assert.deepEqual(await seedance.prepare(constraints(referenced)).compile(resolve), {
    model: "bytedance/seedance-2.0",
    prompt: "go", resolution: "4K", aspect_ratio: "9:16", duration: 8, generate_audio: true,
    input_references: [
      { type: "image_url", image_url: { url: "https://example.test/res_openrouter_1" } },
      { type: "audio_url", audio_url: { url: "https://example.test/res_openrouter_2" } },
    ],
  });
  const framed = sealSeedanceRequest("seedance-2", {
    ...base,
    firstFrame: [{ role: "image", artifact: image, fields: { personReference: true } }],
    lastFrame: [{ role: "image", artifact: image, fields: { personReference: false } }],
  });
  assert.deepEqual((await seedance.prepare(constraints(framed)).compile(resolve)).frame_images, [
    { type: "image_url", image_url: { url: "https://example.test/res_openrouter_1" }, frame_type: "first_frame" },
    { type: "image_url", image_url: { url: "https://example.test/res_openrouter_1" }, frame_type: "last_frame" },
  ]);
});

test("values outside OpenRouter's published ranges are unsupported before submission", () => {
  const base = { prompt: ["go"], resolution: ["720p"], aspectRatio: ["16:9"], duration: [8], generateAudio: [true], webSearch: [false] };
  const seedance25 = route("@hypit/seedance", "seedance-2.5");
  assert.equal(supported(seedance25, sealSeedanceRequest("seedance-2.5", base)), "supported");
  assert.equal(supported(seedance25, sealSeedanceRequest("seedance-2.5", { ...base, resolution: ["1080p"] })), "unsupported");
  assert.equal(supported(seedance25, sealSeedanceRequest("seedance-2.5", { ...base, duration: [-1] })), "unsupported");
  const mini = route("@hypit/seedance", "seedance-2-mini");
  assert.equal(supported(mini, sealSeedanceRequest("seedance-2-mini", { ...base, aspectRatio: ["adaptive"] })), "unsupported");
  assert.equal(supported(mini, sealSeedanceRequest("seedance-2-mini", { ...base, webSearch: [true] })), "unsupported");

  const gpt = route("@hypit/gpt-image", "gpt-image-2");
  assert.equal(supported(gpt, sealGptImage2Request({ prompt: ["a"], aspectRatio: ["9:16"], resolution: ["2K"] })), "supported");
  assert.equal(supported(gpt, sealGptImage2Request({ prompt: ["a"], aspectRatio: ["5:4"], resolution: ["2K"] })), "unsupported");
  assert.equal(supported(gpt, sealGptImage2Request({ prompt: ["a"], aspectRatio: ["1:1"], resolution: ["1K"], background: ["transparent"] })), "unsupported");

  const pro = route("@hypit/nano-banana", "nano-banana-pro");
  assert.equal(supported(pro, sealNanoBananaRequest("nano-banana-pro", { prompt: ["a"], aspectRatio: ["auto"], resolution: ["2K"], outputFormat: ["png"] })), "unsupported");
});

test("Seedream quality becomes the OpenRouter resolution tier and unsupported fields are not sent", async () => {
  const seedream = route("@hypit/seedream", "seedream-5-lite");
  const request = sealSeedreamRequest({ prompt: ["a cup"], aspectRatio: ["9:16"], quality: ["ultra"], outputFormat: ["png"], nsfwCheck: [true], images: [{ role: "image", artifact: image }] });
  assert.deepEqual(await seedream.prepare(constraints(request)).compile(resolve), {
    model: "bytedance-seed/seedream-5-0-lite", prompt: "a cup", aspect_ratio: "9:16", resolution: "4K", output_format: "png", n: 1,
    input_references: [{ type: "image_url", image_url: { url: "https://example.test/res_openrouter_1" } }],
  });
  assert.equal(supported(seedream, sealSeedreamRequest({ ...request.ports, quality: ["high"] })), "unsupported");
});

test("an image request posts to /images and stores the returned bytes", async () => {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const registry = new EndpointRegistry();
  await createOpenRouterProvider({
    fetch: async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json({ created: 1, data: [{ b64_json: Buffer.from("png").toString("base64"), media_type: "image/png" }] });
    },
  }).install(registry);
  const request = {
    id: "need:openrouter-image", capability: gptImageEndpoints.image!.capability, returns: gptImageEndpoints.image!.returns,
    constraints: constraints(sealGptImage2Request({ prompt: ["a lamp"], aspectRatio: ["1:1"], resolution: ["1K"] })),
    result: "record:openrouter-image",
  };
  const resolution = registry.resolve(request);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const resources = new MemoryResourceStore();
  const result = await resolution.registration.handler({
    command: { kind: "fulfill-need", id: "command:openrouter-image", need: request }, need: request, resources,
    credentials: { apiKey: { secret: "test-key" } },
  });
  assert.deepEqual(calls, [{
    url: "https://openrouter.ai/api/v1/images", auth: "Bearer test-key",
    body: { model: "openai/gpt-image-2", prompt: "a lamp", aspect_ratio: "1:1", resolution: "1K", n: 1 },
  }]);
  const images = (result.value.kind === "inline" ? result.value.value as { images: BlobRef[] } : { images: [] }).images;
  assert.equal(images.length, 1);
  assert.deepEqual(await resources.get(images[0]!.resource), new Uint8Array(Buffer.from("png")));
});
