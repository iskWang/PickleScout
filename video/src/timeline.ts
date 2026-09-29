export const FPS = 30;
export const TRANSITION = 12;

// Each scene overlaps the next by TRANSITION frames (cross-fade).
export const SCENES = [
  { id: "intro", duration: 126 },
  { id: "input", duration: 162 },
  { id: "explore", duration: 177 },
  { id: "generate", duration: 162 },
  { id: "verify", duration: 162 },
  { id: "package", duration: 102 },
  { id: "outro", duration: 81 },
] as const;

export type SceneId = (typeof SCENES)[number]["id"];

export const SCENE_START: Record<SceneId, number> = (() => {
  const starts = {} as Record<SceneId, number>;
  let at = 0;
  for (const scene of SCENES) {
    starts[scene.id] = at;
    at += scene.duration - TRANSITION;
  }
  return starts;
})();

export const TOTAL_FRAMES =
  SCENES.reduce((sum, s) => sum + s.duration, 0) - TRANSITION * (SCENES.length - 1);
