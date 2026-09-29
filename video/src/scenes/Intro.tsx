import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, clamp } from "../components";
import { C, sans } from "../theme";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 4, fps, config: { damping: 11, stiffness: 110 } });
  const float = Math.sin(frame / 14) * 6;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
      <div
        style={{
          position: "absolute",
          width: 820,
          height: 820,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${C.brandGlow} 0%, transparent 65%)`,
          opacity: interpolate(frame, [0, 40], [0, 1], clamp),
          top: 40,
        }}
      />
      <Img
        src={staticFile("logo.png")}
        style={{
          width: 320,
          height: 320,
          transform: `translateY(${float}px) scale(${pop}) rotate(${interpolate(pop, [0, 1], [-18, 0])}deg)`,
        }}
      />
      <div
        style={{
          ...appear(frame, fps, 20),
          fontFamily: sans,
          fontWeight: 800,
          fontSize: 132,
          letterSpacing: -4,
          color: C.text,
          marginTop: 12,
        }}
      >
        Pickle<span style={{ color: C.brand }}>Scout</span>
      </div>
      <div style={{ ...appear(frame, fps, 42), fontFamily: sans, fontWeight: 600, fontSize: 56, color: C.muted }}>
        Browse once. <span style={{ color: C.brand }}>Test forever.</span>
      </div>
      <div
        style={{
          ...appear(frame, fps, 64),
          fontFamily: sans,
          fontSize: 32,
          color: C.faint,
          marginTop: 22,
        }}
      >
        LLM browser agent → ready-to-run Cucumber.js + Playwright tests
      </div>
    </AbsoluteFill>
  );
};
