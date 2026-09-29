import React from "react";
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { appear } from "../components";
import { C, mono, sans } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 6, fps, config: { damping: 14 } });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 36, transform: `scale(${0.9 + 0.1 * pop})`, opacity: pop }}>
        <Img src={staticFile("logo.png")} style={{ width: 200, height: 200 }} />
        <div style={{ fontFamily: sans, fontWeight: 800, fontSize: 120, letterSpacing: -4, color: C.text }}>
          Pickle<span style={{ color: C.brand }}>Scout</span>
        </div>
      </div>
      <div style={{ ...appear(frame, fps, 16), fontFamily: sans, fontWeight: 600, fontSize: 56, color: C.muted, marginTop: 24 }}>
        Browse once. <span style={{ color: C.brand }}>Test forever.</span>
      </div>
      <div
        style={{
          ...appear(frame, fps, 30),
          marginTop: 48,
          padding: "14px 32px",
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          background: C.surface,
          fontFamily: mono,
          fontSize: 32,
          color: C.text,
        }}
      >
        github.com/iskWang/PickleScout
      </div>
      <div style={{ ...appear(frame, fps, 40), marginTop: 20, fontFamily: sans, fontSize: 26, color: C.faint }}>
        Open source · MIT
      </div>
    </AbsoluteFill>
  );
};
