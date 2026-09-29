import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { appear, Caption, ClickRipple, Cursor, cursorAt, StatusPill, typed, Window } from "../components";
import { C, mono, sans } from "../theme";

// Scene-local frames for each agent action. The browser page and the ActionLog both read these.
const T = { signIn: 44, email: 64, password: 84, logIn: 104, observe: 118, addToCart: 140 };

const ACTIONS: { at: number; kind: string; target: string; color: string }[] = [
  { at: 6, kind: "goto", target: "demo-shop.example.com", color: C.exploring },
  { at: T.signIn, kind: "click", target: '"Sign in"', color: C.brand },
  { at: T.email, kind: "fill", target: "#email", color: C.generating },
  { at: T.password, kind: "fill", target: "#password", color: C.generating },
  { at: T.logIn, kind: "click", target: '"Log in"', color: C.brand },
  { at: T.observe, kind: "observe", target: '"Hi, Alex"', color: C.verifying },
  { at: T.addToCart, kind: "click", target: '"Add to cart"', color: C.brand },
];

const PRODUCTS = [
  { name: "Dill Pickle Jar", price: "$6.90", hue: "#22c55e" },
  { name: "Spicy Spears", price: "$7.50", hue: "#f59e0b" },
  { name: "Sweet Gherkins", price: "$5.20", hue: "#a78bfa" },
];

const Button: React.FC<{ label: string; primary?: boolean; style?: React.CSSProperties }> = ({ label, primary, style }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      fontFamily: sans,
      fontWeight: 600,
      fontSize: 20,
      background: primary ? C.brand : C.surface3,
      color: primary ? C.bg : C.text,
      ...style,
    }}
  >
    {label}
  </div>
);

const LoginPage: React.FC<{ frame: number }> = ({ frame }) => {
  const input = (value: string, focused: boolean, top: number) => (
    <div
      style={{
        position: "absolute",
        left: 330,
        top,
        width: 400,
        height: 54,
        borderRadius: 8,
        background: C.bg,
        border: `2px solid ${focused ? C.exploring : C.border}`,
        fontFamily: mono,
        fontSize: 22,
        color: C.text,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
      }}
    >
      {value}
    </div>
  );
  return (
    <>
      <div style={{ position: "absolute", left: 300, top: 70, width: 460, height: 400, borderRadius: 16, background: C.surface2, border: `1px solid ${C.border}` }} />
      <div style={{ position: "absolute", left: 330, top: 96, fontFamily: sans, fontWeight: 800, fontSize: 32, color: C.text }}>Sign in</div>
      {input(typed("alex@example.com", frame, T.email + 2, 1.5), frame >= T.email && frame < T.password, 160)}
      {input("•".repeat(Math.min(10, Math.max(0, Math.floor((frame - T.password - 2) * 1.2)))), frame >= T.password && frame < T.logIn, 244)}
      <Button label="Log in" primary style={{ position: "absolute", left: 330, top: 336, width: 400, height: 58 }} />
    </>
  );
};

const HomePage: React.FC<{ frame: number; signedIn: boolean }> = ({ frame, signedIn }) => {
  const cartCount = frame >= T.addToCart + 4 ? 1 : 0;
  return (
    <>
      <div style={{ position: "absolute", left: 40, top: 30, fontFamily: sans, fontWeight: 800, fontSize: 40, color: C.text }}>
        Fresh pickles, delivered.
      </div>
      <div style={{ position: "absolute", left: 40, top: 86, fontFamily: sans, fontSize: 22, color: C.muted }}>
        {signedIn ? "Hi, Alex — welcome back." : "Small-batch, crunchy, shipped weekly."}
      </div>
      {PRODUCTS.map((p, i) => (
        <div
          key={p.name}
          style={{
            position: "absolute",
            left: 40 + i * 330,
            top: 150,
            width: 300,
            height: 320,
            borderRadius: 14,
            background: C.surface2,
            border: `1px solid ${C.border}`,
            overflow: "hidden",
          }}
        >
          <div style={{ height: 150, background: `linear-gradient(135deg, ${p.hue}55, ${p.hue}11)` }} />
          <div style={{ padding: "16px 18px", fontFamily: sans }}>
            <div style={{ fontSize: 24, fontWeight: 600, color: C.text }}>{p.name}</div>
            <div style={{ fontSize: 20, color: C.muted, marginTop: 4 }}>{p.price}</div>
          </div>
          <Button label="Add to cart" primary={i === 0} style={{ position: "absolute", left: 18, bottom: 18, width: 264, height: 48 }} />
        </div>
      ))}
      <div style={{ position: "absolute", right: 40, top: 36, padding: "8px 18px", borderRadius: 999, background: cartCount ? `${C.brand}33` : C.surface2, border: `1px solid ${cartCount ? C.brand : C.border}`, fontFamily: sans, fontWeight: 600, fontSize: 20, color: C.text }}>
        Cart · {cartCount}
      </div>
    </>
  );
};

export const Explore: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const page = frame < T.signIn + 6 ? "home" : frame < T.logIn + 8 ? "login" : "signedIn";
  const cursor = cursorAt(frame, [
    { f: 0, x: 560, y: 420 },
    { f: T.signIn - 4, x: 980, y: -27 },
    { f: T.email - 4, x: 520, y: 186 },
    { f: T.password - 4, x: 520, y: 270 },
    { f: T.logIn - 4, x: 520, y: 364 },
    { f: T.addToCart - 4, x: 190, y: 432 },
  ]);
  const pressed = [T.signIn, T.logIn, T.addToCart].some((t) => frame >= t && frame < t + 5);

  return (
    <AbsoluteFill>
      <Window
        title="Stagehand · Chromium"
        x={80}
        y={170}
        width={1060}
        height={660}
        right={<StatusPill label="exploring" color={C.exploring} />}
        style={appear(frame, fps, 0, 40)}
      >
        <div
          style={{
            height: 54,
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "0 20px",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div style={{ flex: 1, height: 36, borderRadius: 18, background: C.bg, display: "flex", alignItems: "center", padding: "0 18px", fontFamily: mono, fontSize: 18, color: C.muted }}>
            https://demo-shop.example.com{page === "login" ? "/login" : ""}
          </div>
          <Button label={page === "signedIn" ? "Alex" : "Sign in"} style={{ width: 120, height: 36 }} />
        </div>
        <div style={{ position: "relative", height: 554 }}>
          {page === "login" ? <LoginPage frame={frame} /> : <HomePage frame={frame} signedIn={page === "signedIn"} />}
          <ClickRipple x={980} y={-27} at={T.signIn} color={C.exploring} />
          <ClickRipple x={530} y={365} at={T.logIn} color={C.exploring} />
          <ClickRipple x={190} y={432} at={T.addToCart} color={C.exploring} />
          <Cursor x={cursor.x} y={cursor.y} pressed={pressed} />
        </div>
      </Window>

      <Window title="action-log.json" x={1180} y={170} width={660} height={660} style={appear(frame, fps, 6, 40)}>
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          {ACTIONS.map((a) => (
            <div
              key={a.at}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "12px 16px",
                borderRadius: 10,
                background: C.surface2,
                border: `1px solid ${C.border}`,
                fontFamily: mono,
                fontSize: 22,
                ...appear(frame, fps, a.at, 14),
              }}
            >
              <span style={{ width: 110, color: a.color, fontWeight: 600 }}>{a.kind}</span>
              <span style={{ color: C.text }}>{a.target}</span>
            </div>
          ))}
        </div>
      </Window>

      <Caption start={16}>
        <span style={{ color: C.exploring }}>01 Explore</span> — an LLM agent clicks through your app and logs every step.
      </Caption>
    </AbsoluteFill>
  );
};
