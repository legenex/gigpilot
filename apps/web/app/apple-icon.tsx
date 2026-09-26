import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#08090B" }}>
        <svg width="132" height="132" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="12.25" fill="none" stroke="#EDEEF0" strokeOpacity="0.92" strokeWidth="1.6" />
          <path d="M16 3.75v3.1M16 25.15v3.1M3.75 16h3.1M25.15 16h3.1" stroke="#EDEEF0" strokeOpacity="0.45" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M10.2 21.8 21.4 10.6m0 0h-7.3m7.3 0v7.3" fill="none" stroke="#FF6B2C" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    size,
  );
}
