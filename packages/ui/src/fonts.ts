import { Inter, JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";

/** Shared brand fonts. Apply `fontVariables` to <html className>. */
export const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
export const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap", weight: ["500", "600", "700", "800"] });
export const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap", weight: ["400", "500", "600"] });

export const fontVariables = `${inter.variable} ${schibsted.variable} ${jetbrains.variable}`;
