import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, Caption, Code, codeLength, StatusPill, Tok, Window } from "../components";
import { C, mono } from "../theme";

const KW = C.generating;
const STR = C.brand;
const DIM = C.muted;

const FEATURE: Tok[][] = [
  [{ t: "Feature:", c: KW }, { t: " Checkout" }],
  [],
  [{ t: "  Scenario:", c: KW }, { t: " Signed-in user places an order" }],
  [{ t: "    Given", c: KW }, { t: " I am on the home page" }],
  [{ t: "    When", c: KW }, { t: " I sign in as a registered user" }],
  [{ t: "    And", c: KW }, { t: " I add " }, { t: '"Dill Pickle Jar"', c: STR }, { t: " to the cart" }],
  [{ t: "    And", c: KW }, { t: " I check out" }],
  [{ t: "    Then", c: KW }, { t: " I see the order confirmation" }],
];

const STEPS: Tok[][] = [
  [{ t: "When", c: KW }, { t: "(" }, { t: "'I sign in as a registered user'", c: STR }, { t: "," }],
  [{ t: "  async function ", c: KW }, { t: "() {" }],
  [{ t: "    await ", c: KW }, { t: "this.page.fill(" }, { t: "'#email'", c: STR }, { t: "," }],
  [{ t: "      process.env.APP_USER);", c: DIM }],
  [{ t: "    await ", c: KW }, { t: "this.page.fill(" }, { t: "'#password'", c: STR }, { t: "," }],
  [{ t: "      process.env.APP_PASS);", c: DIM }],
  [{ t: "    await ", c: KW }, { t: "this.page.click(" }, { t: "'text=Log in'", c: STR }, { t: ");" }],
  [{ t: "  });" }],
];

const FEATURE_START = 10;
const FEATURE_CPF = 3.2;
const STEPS_START = 58;
const STEPS_CPF = 3.6;

const PassChip: React.FC<{ n: number; label: string; style: React.CSSProperties }> = ({ n, label, style }) => (
  <div style={{ position: "absolute", top: 150, display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 22, color: C.muted, ...style }}>
    <span style={{ padding: "4px 12px", borderRadius: 8, background: `${C.generating}22`, color: C.generating, fontWeight: 600 }}>
      Pass {n}
    </span>
    {label}
  </div>
);

export const Generate: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const featureChars = Math.max(0, (frame - FEATURE_START) * FEATURE_CPF);
  const stepsChars = Math.max(0, (frame - STEPS_START) * STEPS_CPF);
  const done = stepsChars >= codeLength(STEPS);

  return (
    <AbsoluteFill>
      <PassChip n={1} label="ActionLog → Gherkin" style={{ left: 70, ...appear(frame, fps, 0) }} />
      <PassChip n={2} label="Gherkin → IntentSpec → step definitions" style={{ left: 990, ...appear(frame, fps, STEPS_START - 8) }} />

      <Window title="features/01_checkout.feature" x={60} y={200} width={890} height={600} style={appear(frame, fps, 0, 40)}>
        <div style={{ padding: "26px 32px" }}>
          <Code lines={FEATURE} visibleChars={featureChars} />
        </div>
      </Window>

      <Window
        title="steps/01_checkout.steps.ts"
        x={980}
        y={200}
        width={880}
        height={600}
        right={<StatusPill label={done ? "written" : "generating"} color={done ? C.completed : C.generating} />}
        style={appear(frame, fps, STEPS_START - 8, 40)}
      >
        <div style={{ padding: "26px 32px" }}>
          <Code lines={STEPS} visibleChars={stepsChars} />
        </div>
      </Window>

      <Caption start={16}>
        <span style={{ color: C.generating }}>02 Generate</span> — plain-English Gherkin plus typed Playwright steps.
      </Caption>
    </AbsoluteFill>
  );
};
