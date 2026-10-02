// Turning Discourse's HTML into words.
//
// PURE, and in its own file because BOTH stages need it and neither should
// depend on the other: the listing (stage one) carries an HTML `excerpt`, and a
// thread (stage two) carries HTML `cooked` bodies. Having topics.ts import from
// discussion.ts would make the cheap half depend on the expensive one for a
// string function.
//
// ⚠️ ENTITIES MUST BE DECODED, AND "LEAVE IT EXACTLY AS SENT" IS NOT FIDELITY.
// The excerpt was originally stored raw on the reasoning that quoted material
// should not be tidied. That is right about the wording and wrong about the
// encoding: React escapes what it renders, so an undecoded excerpt reached the
// screen as "these models reco&hellip;" — visible in the browser, invisible to
// every API-level test. Decoding is not editing somebody's words; it is
// rendering them.

/** Named entities Discourse actually emits. Numeric forms are handled below. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    // `&amp;` is deliberately last among the named ones by virtue of one pass:
    // decoding it first would turn "&amp;lt;" into "<" rather than "&lt;".
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[String(name).toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Discourse ships post bodies as HTML in `cooked`. This is not a general HTML
 *  parser and does not need to be: the goal is the words, and the markup is
 *  Discourse's own limited set.
 *
 *  Blockquotes are DROPPED rather than flattened. A quoted reply would otherwise
 *  repeat the text it is answering, and a model reading the thread would see the
 *  same sentence three times and weight it three times. */
export function htmlToText(html: unknown): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<li>/gi, '\n• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
