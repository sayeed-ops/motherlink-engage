// Resolve hook — see ./register.mjs for why each rule exists.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src');

/** An empty ES module, inline — no file to keep in sync. */
const EMPTY = 'data:text/javascript,export {}';

/** What a TypeScript import might have meant when it named no extension. */
const SUFFIXES = ['.ts', '.tsx', '/index.ts'];

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') {
    return { url: EMPTY, shortCircuit: true };
  }

  const target = specifier.startsWith('@/')
    ? pathToFileURL(resolvePath(SRC, specifier.slice(2))).href
    : specifier;

  try {
    return await next(target, context);
  } catch (err) {
    // TypeScript source omits the extension and the app's bundler supplies it;
    // Node does not. Only ever tried AFTER the plain specifier has failed, so a
    // real package resolution is never shadowed by a file that happens to share
    // its name.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    for (const suffix of SUFFIXES) {
      try {
        return await next(`${target}${suffix}`, context);
      } catch (retry) {
        if (retry?.code !== 'ERR_MODULE_NOT_FOUND') throw retry;
      }
    }
    throw err;
  }
}
