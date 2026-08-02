import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the file-tracing root to the repo root.
  //
  // This repo has no root package.json but three below it (apps/web,
  // apps/poster-agent, tools) and two lockfiles, so Next has to INFER a
  // workspace root. Pinning it makes tracing deterministic rather than guessed.
  // See node_modules/next/dist/docs/01-app/03-api-reference/05-config/
  // 01-next-config-js/output.md — "Caveats".
  //
  // NB this was added on a wrong diagnosis of the deploy-time
  // "Failed to load external module firebase-admin" 500s. The full Vercel log
  // (the dashboard truncates it) showed the module was present and the real
  // fault was ERR_REQUIRE_ESM inside jwks-rsa — fixed by the `jose` override in
  // package.json. Kept because it is correct for this layout, not because it
  // fixed that.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
