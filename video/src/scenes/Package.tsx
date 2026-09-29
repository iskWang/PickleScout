import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, Caption, Window } from "../components";
import { C, mono, sans } from "../theme";

// Mirrors the "Output structure" section of README.md.
const TREE: { depth: number; name: string; note?: string }[] = [
  { depth: 0, name: "generated-tests/" },
  { depth: 1, name: "features/", note: "Gherkin scenarios" },
  { depth: 1, name: "steps/", note: "Playwright step definitions" },
  { depth: 1, name: "support/", note: "World + hooks" },
  { depth: 1, name: "cucumber.js" },
  { depth: 1, name: "playwright.config.ts" },
  { depth: 1, name: "package.json", note: "pinned versions" },
  { depth: 1, name: ".github/workflows/e2e.yml", note: "CI ready" },
];

const BADGES = ["Zero LLM calls at runtime", "Cucumber.js + Playwright", "Drop into any CI/CD"];

export const Package: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zipPop = spring({ frame: frame - 24, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill>
      <Window title="result.zip" x={120} y={170} width={860} height={640} style={appear(frame, fps, 0, 40)}>
        <div style={{ padding: "30px 36px", fontFamily: mono, fontSize: 26, lineHeight: 1.9 }}>
          {TREE.map((item, i) => (
            <div key={item.name} style={{ display: "flex", gap: 16, paddingLeft: item.depth * 36, ...appear(frame, fps, 4 + i * 4, 10) }}>
              <span style={{ color: item.name.endsWith("/") ? C.brand : C.text }}>{item.name}</span>
              {item.note && <span style={{ color: C.faint }}>— {item.note}</span>}
            </div>
          ))}
        </div>
      </Window>

      <div style={{ position: "absolute", left: 1060, top: 190, width: 740, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            width: 220,
            height: 260,
            borderRadius: 22,
            background: `linear-gradient(160deg, ${C.brand}, ${C.brandDim})`,
            boxShadow: `0 0 80px ${C.brandGlow}`,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: 30,
            transform: `scale(${zipPop})`,
            fontFamily: sans,
            fontWeight: 800,
            fontSize: 44,
            color: C.bg,
          }}
        >
          .zip
        </div>
        <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 18, alignItems: "center" }}>
          {BADGES.map((b, i) => (
            <div
              key={b}
              style={{
                padding: "12px 28px",
                borderRadius: 999,
                border: `1px solid ${C.border}`,
                background: C.surface,
                fontFamily: sans,
                fontWeight: 600,
                fontSize: 28,
                color: C.text,
                ...appear(frame, fps, 36 + i * 8, 16),
              }}
            >
              <span style={{ color: C.brand }}>✓</span> {b}
            </div>
          ))}
        </div>
      </div>

      <Caption start={12}>
        <span style={{ color: C.brand }}>04 Package</span> — download a test project you own.
      </Caption>
    </AbsoluteFill>
  );
};
