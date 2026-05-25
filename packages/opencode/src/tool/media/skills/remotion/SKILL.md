---
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

```ts
await $`bunx create-video@latest --yes --blank --no-tailwind my-video`
```

Replace `my-video` with a suitable project name.

For best results, install the official Remotion agent skills:

```ts
await $`bunx skills@latest add remotion-dev/skills -g -y`
```

This loads comprehensive rules for captions, FFmpeg, audio visualization, 3D, Google Fonts, Lottie, transitions, maps, voiceover, and more.

## Workflow
All Remotion commands go through the **TypeScript tool** — never bash:

1. **Scaffold** → `bunx create-video@latest` (via TypeScript tool)
2. **Write code** → Use the edit tool on `src/Root.tsx` and composition files
3. **Install deps** → `$`bun install`` (via TypeScript tool)
4. **Preview** → `$`bunx remotion studio`` (via TypeScript tool)
5. **Render** → `$`bunx remotion render <id> out/video.mp4`` (via TypeScript tool)

## Starting preview
Start the Remotion Studio to preview a video using the TypeScript tool:

```ts
await $`bunx remotion studio`
```

## Designing a video
Animate properties using `useCurrentFrame()` and `interpolate()`. Use Easing to customize the timing of the animation.

```tsx
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
```

CSS transitions or animations are FORBIDDEN — they will not render correctly.
Tailwind animation class names are FORBIDDEN — they will not render correctly.

## Assets
Place assets in the `public/` folder at your project root.

Use `staticFile()` to reference files from the `public/` folder:

```tsx
import { Img, staticFile } from "remotion";

export const MyComposition = () => {
  return <Img src={staticFile("logo.png")} style={{ width: 100, height: 100 }} />;
};
```

Add videos using `<Video>` and audio using `<Audio>` from `@remotion/media`:

```tsx
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
```

Assets can also be referenced as remote URLs:

```tsx
import { Video } from "@remotion/media";

export const MyComposition = () => {
  return <Video src="https://remotion.media/video.mp4" />;
};
```

## Sequencing
To delay content wrap it in `<Sequence>` and use `from`.
To limit the duration of an element, use `durationInFrames` of `<Sequence>`.
`<Sequence>` by default is an absolute fill. For inline content, use `layout="none"`.

```tsx
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
```

## Composition definition
The width, height, fps, and duration of a video is defined in `src/Root.tsx`:

```tsx
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
```

Metadata can also be calculated dynamically:

```tsx
import { Composition, CalculateMetadataFunction } from "remotion";

const calculateMetadata: CalculateMetadataFunction<MyCompositionProps> = async ({ props, abortSignal }) => {
  const data = await fetch(`https://api.example.com/video/${props.videoId}`, {
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
```

## Rendering
Render the final video using the TypeScript tool:

```ts
await $`bunx remotion render <composition-id> out/video.mp4`
```

### One-frame render check
You can render a single frame with the CLI to sanity-check layout, colors, or timing:

```ts
await $`bunx remotion still <composition-id> --scale=0.25 --frame=30`
```

At 30 fps, `--frame=30` is the one-second mark (`--frame` is zero-based).

## Key concepts
- **`useCurrentFrame()`** — current frame number
- **`useVideoConfig()`** — `{ width, height, fps, durationInFrames }`
- **`interpolate()`** — map values across frames with easing
- **`spring()`** — physics-based animation
- **`<Sequence>`** — layout and time-shift content within a video
- **`staticFile()`** — reference files from the `public/` folder
- **`<Img>`, `<Video>`, `<Audio>`** — media elements

## Pitfalls
- Always wrap compositions in `<Composition>` in `Root.tsx`
- `durationInFrames = fps * durationInSeconds`
- Use `staticFile()` for assets, not relative paths
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

Install them with: `bunx skills@latest add remotion-dev/skills -g -y`
