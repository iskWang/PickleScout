import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, mono, sans } from "./theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Spring-driven fade + rise, starting at `start` (scene-local frame). */
export const appear = (
  frame: number,
  fps: number,
  start: number,
  distance = 24,
): React.CSSProperties => {
  const p = spring({ frame: frame - start, fps, config: { damping: 200 } });
  return { opacity: p, transform: `translateY(${(1 - p) * distance}px)` };
};

/** Characters revealed at `frame` for a typewriter starting at `start`. */
export const typed = (text: string, frame: number, start: number, charsPerFrame: number) =>
  text.slice(0, Math.max(0, Math.floor((frame - start) * charsPerFrame)));

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = (frame * 0.4) % 64;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.surface2} 1px, transparent 1px), linear-gradient(90deg, ${C.surface2} 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          backgroundPosition: `${drift}px ${drift}px`,
          opacity: 0.45,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 40%, rgba(74,222,128,0.08) 0%, transparent 60%), radial-gradient(ellipse at 50% 50%, transparent 55%, ${C.bg} 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const Window: React.FC<{
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right?: React.ReactNode;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ title, x, y, width, height, right, style, children }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width,
      height,
      borderRadius: 18,
      background: C.surface,
      border: `1px solid ${C.border}`,
      boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    <div
      style={{
        height: 52,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 20px",
        background: C.surface2,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      {["#f87171", "#fbbf24", "#4ade80"].map((c) => (
        <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c, opacity: 0.85 }} />
      ))}
      <div style={{ marginLeft: 14, fontFamily: mono, fontSize: 20, color: C.muted, flex: 1 }}>{title}</div>
      {right}
    </div>
    <div style={{ position: "relative", flex: 1 }}>{children}</div>
  </div>
);

export const StatusPill: React.FC<{ label: string; color: string; style?: React.CSSProperties }> = ({
  label,
  color,
  style,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      padding: "6px 16px",
      borderRadius: 999,
      background: `${color}22`,
      border: `1px solid ${color}66`,
      color,
      fontFamily: mono,
      fontSize: 20,
      fontWeight: 600,
      ...style,
    }}
  >
    <div style={{ width: 10, height: 10, borderRadius: 5, background: color, boxShadow: `0 0 12px ${color}` }} />
    {label}
  </div>
);

export const Caption: React.FC<{ start?: number; children: React.ReactNode }> = ({ start = 8, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 70,
        textAlign: "center",
        fontFamily: sans,
        fontSize: 44,
        fontWeight: 600,
        color: C.text,
        letterSpacing: -0.5,
        ...appear(frame, fps, start, 16),
      }}
    >
      {children}
    </div>
  );
};

export const Cursor: React.FC<{ x: number; y: number; pressed?: boolean }> = ({ x, y, pressed }) => (
  <svg
    width={36}
    height={36}
    viewBox="0 0 24 24"
    style={{
      position: "absolute",
      left: x,
      top: y,
      transform: `scale(${pressed ? 0.85 : 1})`,
      transformOrigin: "top left",
      filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.6))",
      zIndex: 10,
    }}
  >
    <path d="M3 2 L3 20 L8 15.5 L11.5 22 L14.5 20.5 L11 14 L18 14 Z" fill="#fff" stroke="#0d0f14" strokeWidth={1.4} />
  </svg>
);

/** Expanding ring shown where a click happens. */
export const ClickRipple: React.FC<{ x: number; y: number; at: number; color?: string }> = ({
  x,
  y,
  at,
  color = C.brand,
}) => {
  const frame = useCurrentFrame();
  const t = frame - at;
  if (t < 0 || t > 18) return null;
  const size = interpolate(t, [0, 18], [10, 70]);
  return (
    <div
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `3px solid ${color}`,
        opacity: interpolate(t, [0, 18], [0.9, 0]),
        zIndex: 9,
      }}
    />
  );
};

/** Piecewise cursor path: position at `frame` across ordered keyframes. */
export const cursorAt = (frame: number, keys: { f: number; x: number; y: number }[]) => {
  const fs = keys.map((k) => k.f);
  const opts = { ...clamp, easing: (t: number) => t * t * (3 - 2 * t) };
  // Interpolate segment by segment so every leg gets its own ease-in-out.
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame <= fs[i + 1]) {
      return {
        x: interpolate(frame, [fs[i], fs[i + 1]], [keys[i].x, keys[i + 1].x], opts),
        y: interpolate(frame, [fs[i], fs[i + 1]], [keys[i].y, keys[i + 1].y], opts),
      };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
};

export type Tok = { t: string; c?: string };

export const codeLength = (lines: Tok[][]) =>
  lines.reduce((sum, line) => sum + line.reduce((s, tok) => s + tok.t.length, 0) + 1, 0);

/** Syntax-coloured code block that reveals `visibleChars` characters in reading order. */
export const Code: React.FC<{ lines: Tok[][]; visibleChars: number; fontSize?: number }> = ({
  lines,
  visibleChars,
  fontSize = 24,
}) => {
  let remaining = visibleChars;
  return (
    <div style={{ fontFamily: mono, fontSize, lineHeight: 1.65, whiteSpace: "pre", color: C.text }}>
      {lines.map((line, i) => {
        const visible = remaining > 0;
        const spans = line.map((tok, j) => {
          const shown = tok.t.slice(0, Math.max(0, remaining));
          remaining -= tok.t.length;
          return (
            <span key={j} style={{ color: tok.c ?? C.text }}>
              {shown}
            </span>
          );
        });
        remaining -= 1;
        return <div key={i} style={{ minHeight: fontSize * 1.65, opacity: visible ? 1 : 0 }}>{spans}</div>;
      })}
    </div>
  );
};
