// Lets `node --test` import server-side TypeScript from apps/web directly.
//
// Two things stand in the way, both solved by the resolve hook in ./loader.mjs:
//
//   `import 'server-only'` — that package's default export THROWS by design, to
//   stop server modules being pulled into a client bundle. Node is not a client
//   bundle, so here it is a false positive; the hook maps it to an empty module,
//   which is exactly what the package itself does under the "react-server"
//   condition.
//
//   `@/…` path aliases — tsconfig-only, invisible to Node. The hook rewrites
//   them to apps/web/src. In select.ts every such import is `import type` and is
//   erased before Node ever sees it, but the mapping keeps this harness usable
//   for the next server module someone wants to test.
//
// Types are stripped by --experimental-strip-types (Node 22). Nothing here type
// CHECKS — `npx tsc --noEmit` in apps/web is what does that. This runs the code.

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
