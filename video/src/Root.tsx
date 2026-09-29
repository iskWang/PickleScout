import React from "react";
import { Composition } from "remotion";
import { PickleScoutIntro } from "./PickleScoutIntro";
import { FPS, TOTAL_FRAMES } from "./timeline";

export const Root: React.FC = () => (
  <Composition
    id="PickleScoutIntro"
    component={PickleScoutIntro}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
