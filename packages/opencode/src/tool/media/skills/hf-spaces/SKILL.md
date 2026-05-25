---
name: hf-spaces
description: Use Hugging Face Spaces for free AI inference on images, audio, and video. Use when the user wants to generate images, edit images (background removal, inpainting, upscale), synthesize speech, transcribe audio, or run any AI model without local GPU. The agent searches for the best running Gradio Space, inspects its API automatically, and calls it with the user's files.
references:
  - search
  - schema
  - client
---

# HF Spaces Agent Skill

## When to use
- "Generate an image of..."
- "Remove the background"
- "Upscale this photo"
- "Transcribe this audio"
- "Text to speech"
- "Remove this object from the image"
- "Restore this old photo"

## How it works

1. **Search** — Call HF Spaces search API to find running Gradio Spaces
2. **Inspect** — Fetch `/gradio_api/info` to discover inputs/outputs
3. **Call** — Submit job via HTTP POST
4. **Poll** — Stream SSE response until completion
5. **Save** — Download output file

## Search API

```
GET https://huggingface.co/api/spaces?search=<task>&sdk=gradio&limit=8
```

Filter results: only `sdk === "gradio"` and `stage === "RUNNING"`

## API Schema Discovery

```
GET https://<owner>-<name>.hf.space/gradio_api/info
```

Returns `named_endpoints` with parameter types. Key types:
- `filepath`, `file`, `image`, `audio`, `video` → File inputs
- `str`, `text`, `prompt` → Text inputs

## Calling a Space

### Submit
```
POST https://<space>.hf.space/gradio_api/call/<endpoint>
Body: { "data": [...] }
```

Returns: `{ event_id: "..." }`

### Poll
```
GET https://<space>.hf.space/gradio_api/call/<endpoint>/<event_id>
```

SSE stream. `data: [...]` means complete. `data: {"msg": "..."}` means processing.

## Decision Tree

```
Need AI on an image/video/audio?
├─ Text-to-image → Search "text to image" → FLUX, SDXL
├─ Background removal → Search "remove background" → BRIA-RMBG
├─ Object removal → Search "inpaint" → IOPaint, Cleanup Pictures
├─ Upscale → Search "image super resolution" → Real-ESRGAN
├─ Face restore → Search "face restoration" → CodeFormer, GFPGAN
├─ Text-to-speech → Search "text to speech" → Bark, MMS
├─ Transcription → Search "whisper" → OpenAI Whisper
└─ Video generation → Search "text to video" → ModelScope, AnimateDiff
```

## Rate Limits
- Anonymous: ~100 requests/hour
- With HF_TOKEN: ~1000 requests/hour
- Free Spaces may sleep when idle (30-60s wake time)

## Error Handling
- Space sleeping → Retry after 60s
- Queue timeout → Poll up to 5 minutes
- Input format mismatch → Re-inspect `/gradio_api/info`
- Rate limit (429) → Wait and retry, or use HF_TOKEN
