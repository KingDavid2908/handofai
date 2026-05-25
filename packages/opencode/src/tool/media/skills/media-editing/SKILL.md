---
name: media-editing
description: Decision-making skill for choosing the right media tool and backend. Use when the user wants to create or edit media but it's unclear which technology to use. Provides decision trees for video, image, audio, and conversion workflows.
references:
  - decision-trees
  - workflows
---

# Media Editing Decision Skill

## When to use
- User says "I want to make a video" (unclear approach)
- User has media needs but doesn't specify tool
- Need to choose between local (Remotion/ffmpeg) and cloud (HF Spaces)

## Decision Trees

### "I need a video"
```
Need a video?
├─ From images/data with animations → Use Remotion: scaffold with bunx create-video@latest (via TypeScript tool)
├─ AI-generated from text → HF Spaces "text to video"
├─ Edit existing video (trim, concat, effects) → ffmpeg (media tool: convert_media)
├─ Add subtitles/captions → Use Remotion (via TypeScript tool)
├─ Screen recording / presentation → Use Remotion (via TypeScript tool)
└─ Video overlay on another video → Use Remotion (via TypeScript tool)
```

### "I need to edit an image"
```
Need image editing?
├─ Background removal → HF Spaces (BRIA-RMBG)
├─ Remove object / inpaint → HF Spaces (IOPaint)
├─ Upscale / enhance → HF Spaces (Real-ESRGAN)
├─ Face restore → HF Spaces (CodeFormer)
├─ Generate from text → HF Spaces (FLUX, SDXL)
├─ Convert format / resize → ffmpeg or sharp
└─ Simple crop/rotate → ffmpeg
```

### "I need audio"
```
Need audio?
├─ Text-to-speech → HF Spaces (Bark, MMS)
├─ Transcribe speech → HF Spaces (Whisper)
├─ Extract from video → ffmpeg
├─ Convert format → ffmpeg
└─ Music generation → HF Spaces (MusicGen)
```

### "I need to convert a file"
```
Need conversion?
├─ Video format (mp4, gif, webm, mov) → ffmpeg
├─ Audio format (mp3, wav, ogg, m4a) → ffmpeg
├─ Image format (png, jpg, webp) → ffmpeg or sharp
└─ Extract frames from video → ffmpeg
```

## Workflows

### Create Video with Remotion
1. Use the TypeScript tool to scaffold: `bunx create-video@latest`
2. Install deps with TypeScript tool: `bun install`
3. Edit `src/Root.tsx` and create composition components
4. Preview with TypeScript tool: `bunx remotion studio`
5. Render with TypeScript tool: `bunx remotion render <id> out/video.mp4`
6. For best results, install official skills: `bunx skills@latest add remotion-dev/skills -g -y`

### AI Image Editing Pipeline
1. Use the TypeScript tool to call HF Inference API or HF Spaces
2. Specify task (e.g., "remove background")
3. Provide input image path
4. Check registry first (user favorites → builtin → fetched), then live HF search
5. Call best match, return result

### Format Conversion
1. Use `media` tool with `convert_media` action
2. Provide input file and desired output extension
3. ffmpeg handles transcoding

### Saving a Favorite Space
After successfully using a Space, the agent can save it:
1. Use `media` tool with `save_space` action
2. Provide `name` (space ID) and `options.category`
3. Optionally add `options.note` for context
4. Future tasks in that category will try this Space first

## Registry & Categories

### Built-in Categories
- background-removal, inpainting, upscale, face-restore
- text-to-image, image-to-image
- text-to-video, image-to-video, image-to-3d
- text-to-speech, transcription, music-generation

### User Categories
Users can create custom categories (e.g. "audio-to-video", "style-transfer"):
- Use `media` tool with `add_category` action
- Or use `/media` dialog → Manage Categories → Add New Category

### Update Modes
- **Manual** (default): User clicks "Update Registry Now" in `/media`
- **Auto**: Background refresh at configured interval (daily/weekly/monthly/custom)

## Common Combinations

| Goal | Tools |
|------|-------|
| YouTube video from images | Remotion (via TypeScript tool) |
| Podcast with captions | Remotion (via TypeScript tool) |
| Clean product photo | HF Spaces remove-bg |
| Old photo restoration | HF Spaces face-restore + upscale |
| Video meme (gif) | Remotion composition → ffmpeg convert to gif |
| Voiceover for video | HF Spaces TTS → ffmpeg merge audio+video |
