import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, Caption, StatusPill, Window } from "../components";
import { C, mono, sans } from "../theme";

const HEAL_AT = 62;
const RERUN_AT = 104;
const PASS_AT = 126;

const LINES: { at: number; text: string; color: string; bold?: boolean }[] = [
  { at: 4, text: "$ npx cucumber-js", color: C.muted },
  { at: 20, text: "✓ Guest browses products", color: C.completed },
  { at: 32, text: "✓ Signed-in user places an order", color: C.completed },
  { at: 46, text: "✗ Apply a discount code", color: C.failed },
  { at: 50, text: '    TimeoutError: waiting for "#promo"', color: `${C.failed}bb` },
  { at: RERUN_AT, text: "↻ patch applied — re-running 1 scenario", color: C.selfHealing },
  { at: RERUN_AT + 14, text: "✓ Apply a discount code", color: C.completed },
  { at: PASS_AT, text: "3 scenarios (3 passed)", color: C.completed, bold: true },
];

const DIFF: { at: number; sign: "-" | "+"; text: string }[] = [
  { at: HEAL_AT + 12, sign: "-", text: "page.fill('#promo', code)" },
  { at: HEAL_AT + 24, sign: "+", text: "page.fill('[data-testid=promo]', code)" },
];

export const Verify: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const status =
    frame >= PASS_AT
      ? { label: "completed", color: C.completed }
      : frame >= HEAL_AT && frame < RERUN_AT
        ? { label: "self_healing", color: C.selfHealing }
        : { label: "verifying", color: C.verifying };

  return (
    <AbsoluteFill>
      <Window
        title="generated-tests — cucumber-js"
        x={80}
        y={170}
        width={1020}
        height={660}
        right={<StatusPill label={status.label} color={status.color} />}
        style={appear(frame, fps, 0, 40)}
      >
        <div style={{ padding: "30px 36px", fontFamily: mono, fontSize: 28, lineHeight: 1.75, whiteSpace: "pre" }}>
          {LINES.filter((l) => frame >= l.at).map((l) => (
            <div key={l.at} style={{ color: l.color, fontWeight: l.bold ? 600 : 400, ...appear(frame, fps, l.at, 8) }}>
              {l.text}
            </div>
          ))}
        </div>
      </Window>

      <Window
        title="self-heal.diff"
        x={1140}
        y={300}
        width={700}
        height={400}
        right={<StatusPill label="LLM fix" color={C.selfHealing} />}
        style={{ ...appear(frame, fps, HEAL_AT, 40), borderColor: `${C.selfHealing}88` }}
      >
        <div style={{ padding: "28px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontFamily: sans, fontSize: 22, color: C.muted, ...appear(frame, fps, HEAL_AT + 4, 8) }}>
            Selector changed → repair the step, keep the scenario.
          </div>
          {DIFF.map((d) => (
            <div
              key={d.sign}
              style={{
                fontFamily: mono,
                fontSize: 23,
                padding: "12px 16px",
                borderRadius: 8,
                background: d.sign === "-" ? `${C.failed}1f` : `${C.completed}1f`,
                color: d.sign === "-" ? C.failed : C.completed,
                ...appear(frame, fps, d.at, 10),
              }}
            >
              {d.sign} {d.text}
            </div>
          ))}
        </div>
      </Window>

      <Caption start={16}>
        <span style={{ color: C.verifying }}>03 Verify</span> — it runs the tests, and heals what breaks.
      </Caption>
    </AbsoluteFill>
  );
};
