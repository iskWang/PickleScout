import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: sans } = loadInter("normal", {
  weights: ["400", "600", "800"],
  subsets: ["latin"],
});

export const { fontFamily: mono } = loadMono("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

// Mirrors packages/frontend/src/index.css so the video matches the product UI.
export const C = {
  bg: "#0d0f14",
  surface: "#161a23",
  surface2: "#1e2430",
  surface3: "#252c3b",
  border: "#2a3348",
  brand: "#4ade80",
  brandDim: "#22c55e",
  brandGlow: "rgba(74, 222, 128, 0.18)",
  queued: "#6b7280",
  exploring: "#60a5fa",
  generating: "#a78bfa",
  verifying: "#fb923c",
  selfHealing: "#f59e0b",
  completed: "#4ade80",
  failed: "#f87171",
  text: "#e2e8f0",
  muted: "#94a3b8",
  faint: "#475569",
} as const;
