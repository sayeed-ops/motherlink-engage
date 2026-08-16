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
//   Extensionless relative imports — `./roomProfile` rather than
//   `./roomProfile.ts`. That is the app's convention (its bundler supplies the
//   extension) and Node's resolver does not. The hook retries with `.ts`, and
//   only ever AFTER the plain specifier has failed, so a real package is never
//   shadowed by a source file sharing its name. Until commentKarma this went
//   unnoticed: every cross-module import in the tested files was `import type`,
//   which is erased before Node sees it.
//
// Types are stripped by --experimental-strip-types (Node 22). Nothing here type
// CHECKS — `npx tsc --noEmit` in apps/web is what does that. This runs the code.

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
