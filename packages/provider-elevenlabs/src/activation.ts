import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";

import { createElevenLabsProvider } from "./provider.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-elevenlabs",
  activate(context) {
    if (context.pool === undefined) throw new Error("ElevenLabs Provider Pool is required");
    const config = runtimeConfigObject(context.config, "ElevenLabs");
    runtimeConfigExact(config, ["baseUrl", "apiKey", "defaultConcurrency", "outputFormat", "requestTimeoutMs"], "ElevenLabs");
    const baseUrl = runtimeConfigString(config.baseUrl, "ElevenLabs baseUrl");
    if (baseUrl !== undefined) {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error("ElevenLabs baseUrl must use HTTPS or loopback");
      }
    }
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "ElevenLabs apiKey");
    if (apiKey === undefined) throw new Error("ElevenLabs apiKey CredentialRef is required");
    const outputFormat = runtimeConfigString(config.outputFormat, "ElevenLabs outputFormat");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "ElevenLabs defaultConcurrency");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "ElevenLabs requestTimeoutMs");
    return {
      endpoint: createElevenLabsProvider({
        instance: context.instance,
        pool: context.pool,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        apiKey,
        ...(outputFormat === undefined ? {} : { outputFormat }),
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  hostFacets: [adapter],
};

export default hypitPackage;
