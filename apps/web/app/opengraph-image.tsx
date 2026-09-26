import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "GigPilot — Find profitable work. Win it. Get it done.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#08090B";
const FG = "#EDEEF0";
const FG2 = "#A1A6AE";
const FG3 = "#878C95";
const ACCENT = "#FF6B2C";
const PROFIT = "#3FD68C";
const LINE = "rgba(255,255,255,0.10)";

function ring() {
  const ticks = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const major = i % 6 === 0;
    const r0 = major ? 150 : 160;
    ticks.push(
      <line
        key={i}
        x1={Math.round(250 + Math.cos(a) * r0)}
        y1={Math.round(250 + Math.sin(a) * r0)}
        x2={Math.round(250 + Math.cos(a) * 172)}
        y2={Math.round(250 + Math.sin(a) * 172)}
        stroke={major ? "#676C75" : "#3A3E45"}
        strokeWidth={major ? 2 : 1.25}
      />,
    );
  }
  const stations = [];
  for (let k = 1; k <= 7; k++) {
    const a = Math.PI + (k * Math.PI) / 8;
    stations.push(<circle key={k} cx={Math.round(250 + Math.cos(a) * 205)} cy={Math.round(250 + Math.sin(a) * 205)} r={6} fill={BG} stroke={FG2} strokeWidth={2} />);
  }
  return (
    <svg width="500" height="500" viewBox="0 0 500 500">
      <circle cx="250" cy="250" r="205" fill="none" stroke="#454951" strokeWidth="1.5" />
      <path d="M 45 250 A 205 205 0 0 1 455 250" fill="none" stroke={FG3} strokeWidth="2" />
      {ticks}
      {stations}
      <circle cx="250" cy="250" r="44" fill={BG} stroke="#676C75" strokeWidth="2" />
      <path d="M232 268 268 232m0 0h-22m22 0v22" fill="none" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={Math.round(250 + Math.cos(Math.PI * 1.75) * 205)} cy={Math.round(250 + Math.sin(Math.PI * 1.75) * 205)} r="8" fill={ACCENT} />
    </svg>
  );
}

export default async function Image() {
  const dir = join(process.cwd(), "assets/og");
  const [display, mono] = await Promise.all([readFile(join(dir, "SchibstedGrotesk-SemiBold.ttf")), readFile(join(dir, "JetBrainsMono-Medium.ttf"))]);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: BG, position: "relative", fontFamily: "Schibsted" }}>
        <div style={{ position: "absolute", left: 72, right: 72, top: 64, height: 1, background: LINE, display: "flex" }} />
        <div style={{ position: "absolute", left: 72, right: 72, bottom: 64, height: 1, background: LINE, display: "flex" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "92px 0 92px 72px", width: 780 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="40" height="40" viewBox="0 0 32 32">
              <circle cx="16" cy="16" r="12.25" fill="none" stroke={FG} strokeOpacity="0.9" strokeWidth="1.75" />
              <path d="M10.2 21.8 21.4 10.6m0 0h-7.3m7.3 0v7.3" fill="none" stroke={ACCENT} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: 34, color: FG, letterSpacing: "-0.02em" }}>GigPilot</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 62, lineHeight: 1.02, letterSpacing: "-0.045em", color: FG }}>Find profitable work.</span>
            <span style={{ fontSize: 62, lineHeight: 1.02, letterSpacing: "-0.045em", color: FG2, marginTop: 4 }}>Win it. Get it done.</span>
          </div>
          <div style={{ display: "flex", gap: 28, fontFamily: "Mono", fontSize: 17, letterSpacing: "0.08em", color: FG3 }}>
            <span style={{ display: "flex" }}>
              <span style={{ color: PROFIT }}>50%</span>&nbsp;MIN MARGIN
            </span>
            <span style={{ display: "flex" }}>
              <span style={{ color: PROFIT }}>$300</span>&nbsp;MIN PROFIT
            </span>
            <span style={{ display: "flex" }}>
              <span style={{ color: ACCENT }}>3</span>&nbsp;APPROVALS
            </span>
          </div>
        </div>
        <div style={{ position: "absolute", right: 36, top: 65, display: "flex" }}>{ring()}</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Schibsted", data: display, weight: 600, style: "normal" },
        { name: "Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
