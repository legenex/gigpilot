"use client";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: "#08090b", color: "#edeef0", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ maxWidth: 380, padding: 24 }}>
          <p style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#80858e" }}>GigPilot</p>
          <h1 style={{ fontSize: 20, margin: "8px 0" }}>Something went wrong</h1>
          <p style={{ fontSize: 13, color: "#a1a6ae", lineHeight: 1.5 }}>The dashboard hit an unexpected error. Background agents are unaffected.{error.digest ? ` Ref ${error.digest}.` : ""}</p>
          <button onClick={() => retry()} style={{ marginTop: 16, height: 32, padding: "0 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,.12)", background: "#16181d", color: "#edeef0", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
