# `@hypit/provider-openrouter`

Hypit Runtime Provider for an [OpenRouter](https://openrouter.ai) account. Images are one
synchronous `POST /api/v1/images` call whose base64 results are stored in the current Build.
Videos submit `POST /api/v1/videos`, poll `GET /api/v1/videos/{id}` until the job is terminal, then
download each `unsigned_urls` entry with the account key.

| Capability | OpenRouter model |
| --- | --- |
| `@hypit/seedance@1#seedance-2` | `bytedance/seedance-2.0` |
| `@hypit/seedance@1#seedance-2-fast` | `bytedance/seedance-2.0-fast` |
| `@hypit/seedance@1#seedance-2-mini` | `bytedance/seedance-2.0-mini` |
| `@hypit/seedance@1#seedance-2.5` | `bytedance/seedance-2.5` |
| `@hypit/gpt-image@1#gpt-image-2` | `openai/gpt-image-2` |
| `@hypit/nano-banana@1#nano-banana-2` | `google/gemini-3.1-flash-image` |
| `@hypit/nano-banana@1#nano-banana-pro` | `google/gemini-3-pro-image` |
| `@hypit/seedream@1#seedream-5-lite` | `bytedance-seed/seedream-5-0-lite` |

The Source's model import chooses the model; this Provider only decides how OpenRouter receives it.
OpenRouter's catalogue (`GET /api/v1/videos/models`, `GET /api/v1/images/models`) lists further
models; each one Hypit does not yet describe connects through a Model package and a new mapping here.

Seedance reference images, videos and audio become `input_references` parts (`image_url`,
`video_url`, `audio_url`); first and last frames become `frame_images`. OpenRouter honors audio and
video references for Seedance 2 and newer.

Service limits this Provider reports as unsupported before submitting, from OpenRouter's published
model ranges:

- Seedance takes an explicit aspect ratio; `adaptive` is unsupported. `seedance-2.0` renders 480p to
  4K, the others 480p or 720p. Durations are 4–15 seconds, 4–30 for 2.5; `-1` is unsupported.
  `web-search="true"` is unsupported; `false` is not sent.
- GPT Image 2 renders `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9` and `auto`;
  `background="transparent"` is unsupported. `resolution` is OpenRouter's normalized tier.
- Nano Banana has no `auto` ratio on OpenRouter; Pro also lacks `1:4`, `4:1`, `1:8`, `8:1`.
- Seedream 5.0 lite renders 2K (`quality="basic"`) or 4K (`quality="ultra"`); `high` is
  unsupported. `nsfw-check` has no OpenRouter field and is not sent.

Seedance visual references require `person-reference`; the Provider accepts the declaration and
transmits nothing for it. Reference images and audio travel inline as `data:` URLs. A reference
video must be a public HTTPS URL; configure `publicAssetUrl` when embedding the Provider, otherwise
such a request fails before submission.

```json
{
  "credentials": {
    "platform": { "use": "@hypit/credential-store-platform" }
  },
  "endpoints": {
    "openrouter.default": {
      "use": "@hypit/provider-openrouter",
      "pool": "openrouter.default",
      "config": {
        "apiKey": { "store": "platform", "key": "openrouter.api-key" },
        "defaultConcurrency": 3,
        "pollIntervalMs": 10000
      }
    }
  }
}
```

`baseUrl` defaults to `https://openrouter.ai/api/v1`. Store the API key with
`hypit auth login openrouter.default --runtime hypit.runtime.json`. Optional `requestTimeoutMs`,
`operationTimeoutMs` and `actionLimits` bound single HTTP calls, the whole video job and action
concurrency. HTTP failures keep OpenRouter's `error.code`, message and upstream provider message;
failed, cancelled or expired video jobs keep the job id and `error`, with any URL redacted.
