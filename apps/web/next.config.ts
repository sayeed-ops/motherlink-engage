import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the file-tracing root to the repo root.
  //
  // This repo has no root package.json but three below it (apps/web,
  // apps/poster-agent, tools) and two lockfiles. Next infers a workspace root
  // from that layout and gets it wrong here, so `firebase-admin` — which is on
  // Next's automatic server-externals list, i.e. required at runtime rather
  // than bundled — was not traced into the deployed function. It works locally
  // (node_modules is right there) and fails only once deployed:
  //
  //     Error: Failed to load external module firebase-admin-...
  //     → every API route 500s, FUNCTION_INVOCATION_FAILED
  //
  // Setting the root explicitly makes tracing deterministic instead of inferred.
  // See node_modules/next/dist/docs/01-app/03-api-reference/05-config/
  // 01-next-config-js/output.md — "Caveats".
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
