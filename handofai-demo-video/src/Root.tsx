import { Composition } from "remotion"
import { HandOfAiDemo } from "./HandOfAiDemo"

export const RemotionRoot = () => {
  return (
    <Composition
      id="HandOfAiDemo"
      component={HandOfAiDemo}
      durationInFrames={4500}
      fps={30}
      width={1920}
      height={1080}
    />
  )
}
