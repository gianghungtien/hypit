# `@hypit/provider-elevenlabs`

Hypit Runtime Provider for an [ElevenLabs](https://elevenlabs.io) account. It serves
`@hypit/elevenlabs-speech@1#eleven_ttv_v3` through one synchronous
`POST /v1/text-to-voice/design` call with `model_id: "eleven_ttv_v3"`, the author's
`voice_description` and spoken `text`. Every returned preview is stored as an audio Resource in the
generated audio set; the Surface's `<id>.reference` is the first.

The spoken sample must be 100 to 1000 characters and the description 20 to 1000; other lengths are
reported as unsupported before any request. Previews are MP3 (`mp3_44100_128`) unless `outputFormat`
selects another documented `output_format`.

```json
{
  "credentials": {
    "platform": { "use": "@hypit/credential-store-platform" }
  },
  "endpoints": {
    "elevenlabs.default": {
      "use": "@hypit/provider-elevenlabs",
      "pool": "elevenlabs.default",
      "config": {
        "apiKey": { "store": "platform", "key": "elevenlabs.api-key" }
      }
    }
  }
}
```

`baseUrl` defaults to `https://api.elevenlabs.io`. Store the API key with
`hypit auth login elevenlabs.default --runtime hypit.runtime.json`; it is sent as `xi-api-key`.
Optional `defaultConcurrency` and `requestTimeoutMs` bound concurrent designs and one HTTP call.
HTTP failures keep ElevenLabs' `detail.status` and message, or its validation messages.

The Fish Audio and MiMo voice models are separate Capabilities. A Source using `fish:VoiceDesign`
needs a Provider for that model; switch it to `eleven:VoiceDesign` to use this one.
