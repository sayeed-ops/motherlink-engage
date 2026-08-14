// Resolve hook — see ./register.mjs for why each rule exists.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src');

/** An empty ES module, inline — no file to keep in sync. */
const EMPTY = 'data:text/javascript,export {}';

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') {
    return { url: EMPTY, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    return next(pathToFileURL(resolvePath(SRC, specifier.slice(2))).href, context);
  }
  return next(specifier, context);
}
