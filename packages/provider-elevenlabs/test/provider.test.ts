import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { elevenLabsSpeechEndpoints, sealElevenLabsSpeechRequest } from "@hypit/elevenlabs-speech";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";

import { createElevenLabsProvider } from "../src/provider.js";

const sample = "This is a clear conversational voice sample, with enough room to hear the speaker's warmth, energy and natural rhythm.";
const description = "A warm young woman with bright conversational delivery.";

function need(text: string) {
  return {
    id: "need:elevenlabs-design", capability: elevenLabsSpeechEndpoints.voiceDesign.capability,
    returns: elevenLabsSpeechEndpoints.voiceDesign.returns,
    constraints: sealElevenLabsSpeechRequest("eleven_ttv_v3", { text: [text], voiceDescription: [description] }) as unknown as CanonicalValue,
    result: "record:elevenlabs-design",
  };
}

test("Voice Design posts the description and sample and stores every preview", async () => {
  const calls: { url: string; key: string | null; body: unknown }[] = [];
  const registry = new EndpointRegistry();
  await createElevenLabsProvider({
    fetch: async (input, init) => {
      calls.push({ url: String(input), key: new Headers(init?.headers).get("xi-api-key"), body: JSON.parse(String(init?.body)) });
      return Response.json({ text: sample, previews: [
        { audio_base_64: Buffer.from("one").toString("base64"), generated_voice_id: "v1", media_type: "audio/mpeg", duration_secs: 6 },
        { audio_base_64: Buffer.from("two").toString("base64"), generated_voice_id: "v2", media_type: "audio/mpeg", duration_secs: 6 },
      ] });
    },
  }).install(registry);
  const request = need(sample);
  const resolution = registry.resolve(request);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const resources = new MemoryResourceStore();
  const result = await resolution.registration.handler({
    command: { kind: "fulfill-need", id: "command:elevenlabs-design", need: request }, need: request, resources,
    credentials: { apiKey: { secret: "test-key" } },
  });
  assert.deepEqual(calls, [{
    url: "https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_128", key: "test-key",
    body: { voice_description: description, text: sample, model_id: "eleven_ttv_v3" },
  }]);
  const audios = (result.value.kind === "inline" ? result.value.value as { audios: BlobRef[] } : { audios: [] }).audios;
  assert.equal(audios.length, 2);
  assert.equal(audios[0]!.mediaType, "audio/mpeg");
  assert.deepEqual(await resources.get(audios[0]!.resource), new Uint8Array(Buffer.from("one")));
});

test("a spoken sample shorter than ElevenLabs accepts is unsupported before any request", async () => {
  const registry = new EndpointRegistry();
  await createElevenLabsProvider({ fetch: async () => { throw new Error("must not call fetch"); } }).install(registry);
  const resolution = registry.resolve(need("Too short."));
  assert.notEqual(resolution.status, "resolved");
});
