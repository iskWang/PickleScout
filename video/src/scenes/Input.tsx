import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, Caption, clamp, ClickRipple, Cursor, cursorAt, StatusPill, typed, Window } from "../components";
import { C, mono, sans } from "../theme";

const WIN = { x: 410, y: 170, width: 1100, height: 590 };
const PRESS_AT = 100;

const Field: React.FC<{ label: string; value: string; focused: boolean; width?: number | string }> = ({
  label,
  value,
  focused,
  width = "100%",
}) => (
  <div style={{ width }}>
    <div style={{ fontFamily: sans, fontSize: 20, color: C.muted, marginBottom: 10, fontWeight: 600 }}>{label}</div>
    <div
      style={{
        height: 60,
        borderRadius: 10,
        background: C.bg,
        border: `2px solid ${focused ? C.brand : C.border}`,
        boxShadow: focused ? `0 0 0 4px ${C.brandGlow}` : "none",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        fontFamily: mono,
        fontSize: 24,
        color: C.text,
      }}
    >
      {value}
      {focused && <span style={{ width: 2, height: 28, background: C.brand, marginLeft: 2 }} />}
    </div>
  </div>
);

export const Input: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const url = typed("https://demo-shop.example.com", frame, 14, 1.3);
  const hint = typed("Sign in and place an order", frame, 44, 1.3);
  const cursor = cursorAt(frame, [
    { f: 0, x: 1300, y: 900 },
    { f: 76, x: 1300, y: 900 },
    { f: 96, x: 960, y: 670 },
  ]);
  const pressed = frame >= PRESS_AT && frame < PRESS_AT + 6;
  const queued = frame >= PRESS_AT + 8;

  return (
    <AbsoluteFill>
      <Window title="PickleScout — New job" {...WIN} style={appear(frame, fps, 0, 40)}>
        <div style={{ padding: "36px 48px", display: "flex", flexDirection: "column", gap: 28 }}>
          <Field label="Target URL" value={url} focused={frame >= 10 && frame < 42} />
          <Field label="Hint (optional)" value={hint} focused={frame >= 42 && frame < 72} />
          <div style={{ display: "flex", gap: 24, ...appear(frame, fps, 66) }}>
            <Field label="LLM provider" value="OpenRouter" focused={false} width={300} />
            <Field label="Model" value="gemini-3.1-flash-lite" focused={false} width={430} />
            <Field label="Verification" value="smoke" focused={false} width={200} />
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 8, height: 76, alignItems: "center" }}>
            {queued ? (
              <StatusPill label="queued · job a3f9c2" color={C.queued} style={{ fontSize: 26, ...appear(frame, fps, PRESS_AT + 8, 10) }} />
            ) : (
              <div
                style={{
                  padding: "20px 64px",
                  borderRadius: 12,
                  background: C.brand,
                  color: C.bg,
                  fontFamily: sans,
                  fontWeight: 800,
                  fontSize: 28,
                  transform: `scale(${pressed ? 0.94 : 1})`,
                  boxShadow: `0 0 ${interpolate(frame, [80, 98], [0, 40], clamp)}px ${C.brandGlow}`,
                }}
              >
                Generate tests
              </div>
            )}
          </div>
        </div>
      </Window>
      <ClickRipple x={960} y={670} at={PRESS_AT} />
      <Cursor x={cursor.x} y={cursor.y} pressed={pressed} />
      <Caption start={20}>
        Point it at your web app. <span style={{ color: C.brand }}>That's the whole setup.</span>
      </Caption>
    </AbsoluteFill>
  );
};
