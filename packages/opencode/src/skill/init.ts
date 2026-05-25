import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"

const SKILLS: Record<string, string> = {
  "remotion/SKILL.md": `---
name: remotion
description: Programmatic video creation with React using Remotion. Scaffold projects, create compositions, and render MP4 videos. Uses the TypeScript tool (not bash) for all Remotion operations.
references:
  - composition
  - animation
  - render
  - create-video
---

# Remotion Video Skill

## When to use
Use this skill whenever dealing with Remotion code.
**Always use the TypeScript tool** (not bash) for all Remotion operations — scaffolding, installing deps, preview, and rendering.

## New project setup
Scaffold a new Remotion project using the **TypeScript tool**:

\`\`\`ts
await $\`bunx create-video@latest --yes --blank --no-tailwind my-video\`
\`\`\`

Replace \`my-video\` with a suitable project name.

For best results, install the official Remotion agent skills:

\`\`\`ts
await $\`bunx skills@latest add remotion-dev/skills -g -y\`
\`\`\`

This loads comprehensive rules for captions, FFmpeg, audio visualization, 3D, Google Fonts, Lottie, transitions, maps, voiceover, and more.

## Workflow
All Remotion commands go through the **TypeScript tool** — never bash:

1. **Scaffold** → \`bunx create-video@latest\` (via TypeScript tool)
2. **Write code** → Use the edit tool on \`src/Root.tsx\` and composition files
3. **Install deps** → \`$\`bun install\`\` (via TypeScript tool)
4. **Preview** → \`$\`bunx remotion studio\`\` (via TypeScript tool)
5. **Render** → \`$\`bunx remotion render <id> out/video.mp4\`\` (via TypeScript tool)

## Starting preview
Start the Remotion Studio to preview a video using the TypeScript tool:

\`\`\`ts
await $\`bunx remotion studio\`
\`\`\`

## Designing a video
Animate properties using \`useCurrentFrame()\` and \`interpolate()\`. Use Easing to customize the timing of the animation.

\`\`\`tsx
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

export const FadeIn = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, 2 * fps], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return <div style={{ opacity }}>Hello World!</div>;
};
\`\`\`

CSS transitions or animations are FORBIDDEN — they will not render correctly.
Tailwind animation class names are FORBIDDEN — they will not render correctly.

## Assets
Place assets in the \`public/\` folder at your project root.

Use \`staticFile()\` to reference files from the \`public/\` folder:

\`\`\`tsx
import { Img, staticFile } from "remotion";

export const MyComposition = () => {
  return <Img src={staticFile("logo.png")} style={{ width: 100, height: 100 }} />;
};
\`\`\`

Add videos using \`<Video>\` and audio using \`<Audio>\` from \`@remotion/media\`:

\`\`\`tsx
import { Video, Audio } from "@remotion/media";
import { staticFile } from "remotion";

export const MyComposition = () => {
  return (
    <>
      <Video src={staticFile("video.mp4")} style={{ opacity: 0.5 }} />
      <Audio src={staticFile("audio.mp3")} />
    </>
  );
};
\`\`\`

Assets can also be referenced as remote URLs:

\`\`\`tsx
import { Video } from "@remotion/media";

export const MyComposition = () => {
  return <Video src="https://remotion.media/video.mp4" />;
};
\`\`\`

## Sequencing
To delay content wrap it in \`<Sequence>\` and use \`from\`.
To limit the duration of an element, use \`durationInFrames\` of \`<Sequence>\`.
\`<Sequence>\` by default is an absolute fill. For inline content, use \`layout="none"\`.

\`\`\`tsx
import { Sequence, AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

export const Main = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence>
        <Background />
      </Sequence>
      <Sequence from={1 * fps} durationInFrames={2 * fps} layout="none">
        <Title />
      </Sequence>
      <Sequence from={2 * fps} durationInFrames={2 * fps} layout="none">
        <Subtitle />
      </Sequence>
    </AbsoluteFill>
  );
};
\`\`\`

## Composition definition
The width, height, fps, and duration of a video is defined in \`src/Root.tsx\`:

\`\`\`tsx
import { Composition } from "remotion";
import { MyComposition } from "./MyComposition";

export const RemotionRoot = () => {
  return (
    <Composition
      id="MyComposition"
      component={MyComposition}
      durationInFrames={100}
      fps={30}
      width={1080}
      height={1080}
    />
  );
};
\`\`\`

Metadata can also be calculated dynamically:

\`\`\`tsx
import { Composition, CalculateMetadataFunction } from "remotion";

const calculateMetadata: CalculateMetadataFunction<MyCompositionProps> = async ({ props, abortSignal }) => {
  const data = await fetch(\`https://api.example.com/video/\${props.videoId}\`, {
    signal: abortSignal,
  }).then((res) => res.json());

  return {
    durationInFrames: Math.ceil(data.duration * 30),
    props: { ...props, videoUrl: data.url },
    width: 1080,
    height: 1080,
  };
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="MyComposition"
      component={MyComposition}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={{ videoId: "abc123" }}
      calculateMetadata={calculateMetadata}
    />
  );
};
\`\`\`

## Rendering
Render the final video using the TypeScript tool:

\`\`\`ts
await $\`bunx remotion render <composition-id> out/video.mp4\`
\`\`\`

### One-frame render check
You can render a single frame with the CLI to sanity-check layout, colors, or timing:

\`\`\`ts
await $\`bunx remotion still <composition-id> --scale=0.25 --frame=30\`
\`\`\`

At 30 fps, \`--frame=30\` is the one-second mark (\`--frame\` is zero-based).

## Key concepts
- **\`useCurrentFrame()\`** — current frame number
- **\`useVideoConfig()\`** — \`{ width, height, fps, durationInFrames }\`
- **\`interpolate()\`** — map values across frames with easing
- **\`spring()\`** — physics-based animation
- **\`<Sequence>\`** — layout and time-shift content within a video
- **\`staticFile()\`** — reference files from the \`public/\` folder
- **\`<Img>\`, \`<Video>\`, \`<Audio>\`** — media elements

## Pitfalls
- Always wrap compositions in \`<Composition>\` in \`Root.tsx\`
- \`durationInFrames = fps * durationInSeconds\`
- Use \`staticFile()\` for assets, not relative paths
- ❌ CSS transitions — they will not render
- ❌ Tailwind animation class names — they will not render
- Preload fonts before rendering

## Official rules (from remotion-dev/skills)
The official skills package provides detailed rules for:
- Captions/subtitles, FFmpeg usage, silence detection
- Audio visualization, sound effects, 3D (Three.js/R3F)
- Advanced audio, dynamic metadata, advanced compositions
- Google Fonts, local fonts, audio/video duration
- GIFs, images, light leaks, Lottie, HTML in canvas
- Measuring DOM nodes, measuring text, advanced sequencing
- TailwindCSS, text animations, advanced timing, transitions
- Transparent videos, trimming, parameterized videos, maps, voiceover

Install them with: \`bunx skills@latest add remotion-dev/skills -g -y\`
`,
  "media-editing/SKILL.md": `---
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
\`\`\`
Need a video?
├─ From images/data with animations → Use Remotion: scaffold with bunx create-video@latest (via TypeScript tool)
├─ AI-generated from text → HF Spaces "text to video"
├─ Edit existing video (trim, concat, effects) → ffmpeg (media tool: convert_media)
├─ Add subtitles/captions → Use Remotion (via TypeScript tool)
├─ Screen recording / presentation → Use Remotion (via TypeScript tool)
└─ Video overlay on another video → Use Remotion (via TypeScript tool)
\`\`\`

### "I need to edit an image"
\`\`\`
Need image editing?
├─ Background removal → HF Spaces (BRIA-RMBG)
├─ Remove object / inpaint → HF Spaces (IOPaint)
├─ Upscale / enhance → HF Spaces (Real-ESRGAN)
├─ Face restore → HF Spaces (CodeFormer)
├─ Generate from text → HF Spaces (FLUX, SDXL)
├─ Convert format / resize → ffmpeg or sharp
└─ Simple crop/rotate → ffmpeg
\`\`\`

### "I need audio"
\`\`\`
Need audio?
├─ Text-to-speech → HF Spaces (Bark, MMS)
├─ Transcribe speech → HF Spaces (Whisper)
├─ Extract from video → ffmpeg
├─ Convert format → ffmpeg
└─ Music generation → HF Spaces (MusicGen)
\`\`\`

### "I need to convert a file"
\`\`\`
Need conversion?
├─ Video format (mp4, gif, webm, mov) → ffmpeg
├─ Audio format (mp3, wav, ogg, m4a) → ffmpeg
├─ Image format (png, jpg, webp) → ffmpeg or sharp
└─ Extract frames from video → ffmpeg
\`\`\`

## Workflows

### Create Video with Remotion
1. Use the TypeScript tool to scaffold: \`bunx create-video@latest\`
2. Install deps with TypeScript tool: \`bun install\`
3. Edit \`src/Root.tsx\` and create composition components
4. Preview with TypeScript tool: \`bunx remotion studio\`
5. Render with TypeScript tool: \`bunx remotion render <id> out/video.mp4\`
6. For best results, install official skills: \`bunx skills@latest add remotion-dev/skills -g -y\`

### AI Image Editing Pipeline
1. Use the TypeScript tool to call HF Inference API or HF Spaces
2. Specify task (e.g., "remove background")
3. Provide input image path
4. Check registry first (user favorites → builtin → fetched), then live HF search
5. Call best match, return result

### Format Conversion
1. Use \`media\` tool with \`convert_media\` action
2. Provide input file and desired output extension
3. ffmpeg handles transcoding

### Saving a Favorite Space
After successfully using a Space, the agent can save it:
1. Use \`media\` tool with \`save_space\` action
2. Provide \`name\` (space ID) and \`options.category\`
3. Optionally add \`options.note\` for context
4. Future tasks in that category will try this Space first

## Registry & Categories

### Built-in Categories
- background-removal, inpainting, upscale, face-restore
- text-to-image, image-to-image
- text-to-video, image-to-video, image-to-3d
- text-to-speech, transcription, music-generation

### User Categories
Users can create custom categories (e.g. "audio-to-video", "style-transfer"):
- Use \`media\` tool with \`add_category\` action
- Or use \`/media\` dialog → Manage Categories → Add New Category

### Update Modes
- **Manual** (default): User clicks "Update Registry Now" in \`/media\`
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
`,
}

export async function installBundledSkills() {
  const skillsDir = path.join(Global.Path.data, "skills")
  for (const [file, content] of Object.entries(SKILLS)) {
    const dest = path.join(skillsDir, file)
    if (await Filesystem.exists(dest)) continue
    await Filesystem.write(dest, content)
  }

  const cfg = await Config.getGlobal()
  const paths = cfg.skills?.paths ?? []
  if (!paths.includes(skillsDir)) {
    await Config.updateGlobal({
      ...cfg,
      skills: {
        ...cfg.skills,
        paths: [...paths, skillsDir],
      },
    })
  }
}
