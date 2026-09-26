import { build } from "esbuild";
import { readFileSync } from "node:fs";

/**
 * Bundles the worker (and every workspace package it imports) into a single
 * ESM file runnable with `node dist/index.js`. Third-party dependencies are
 * bundled too, so the image needs no node_modules beyond optional natives.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  // pg's optional native binding is never used.
  external: ["pg-native"],
  define: { "process.env.GIGPILOT_VERSION": JSON.stringify(process.env.GIGPILOT_VERSION ?? pkg.version) },
  banner: {
    js: [
      "import { createRequire as __gpCreateRequire } from 'module';",
      "import { fileURLToPath as __gpFileURLToPath } from 'url';",
      "import { dirname as __gpDirname } from 'path';",
      "const require = __gpCreateRequire(import.meta.url);",
      "const __filename = __gpFileURLToPath(import.meta.url);",
      "const __dirname = __gpDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
