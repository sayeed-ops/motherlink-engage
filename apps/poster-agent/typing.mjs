// Typing a reply into ONE box, and proving that is where it went.
//
// Shared by every path that writes on a site: Reddit replies, Reddit karma
// comments, Shopify Community replies.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY TYPING NEEDS A GUARD
//
// Keystrokes go wherever focus is. When focus leaves the reply box mid-reply —
// a site popup opens over it (the Shopify Community's "Thanks for contributing"
// note for new users does exactly this), the page re-renders, a click lands on
// an overlay — every SPACE scrolls the page and every letter becomes a site
// keyboard shortcut (`/` is "search" on Discourse), and the rest of the reply is
// typed into a search box or a filter. Seen live on 2026-09-17.
//
// So typing is guarded: every few words, overlays the caller knows about are
// closed; before EVERY character, focus is checked and put back in the box if
// it has left; and the page must still be the page we started on.
// Every other text field on the page is snapshotted first, and anything typed
// into one is put back and reported.
//
// Before submit the caller compares the box with the reply (sameText) and
// repairs it with an exact re-insert — also focus-guarded — or refuses to post.
// ════════════════════════════════════════════════════════════════════════════

import { rand, sleep } from './reddit/helpers.mjs';

/**
 * Text as it should compare: the same letters, digits AND punctuation, with
 * whitespace, typographic variants and markdown escapes flattened.
 *
 * Stricter than comparing words — a dropped comma or apostrophe is a changed
 * reply — but blind to what editors legitimately do: a rich editor turns a blank
 * line into a paragraph, a markdown editor escapes `*`, a site may swap ' for ’.
 */
export function normaliseTyped(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1') // markdown escapes
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does the box hold the reply? */
export function sameText(intended, actual) {
  const a = normaliseTyped(intended);
  return a.length > 0 && a === normaliseTyped(actual);
}

/**
 * Where two texts first differ, for the log — "dropped 'e' at 142" reads
 * better than "mismatch".
 */
export function firstDifference(intended, actual) {
  const a = normaliseTyped(intended);
  const b = normaliseTyped(actual);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return null;
  return { at: i, expected: a.slice(i, i + 12), got: b.slice(i, i + 12), expectedLength: a.length, gotLength: b.length };
}

/**
 * Split a reply into typing units: words with their trailing spaces, and line
 * breaks as their own units, so a focus check can sit between every one.
 * `paragraphEnters` is how many Enters a blank line needs (2 in a markdown
 * textarea, 1 in a rich editor).
 */
export function typingUnits(text, paragraphEnters = 1) {
  const units = [];
  const paragraphs = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  paragraphs.forEach((para, p) => {
    if (p > 0) units.push({ key: 'Enter', times: paragraphEnters });
    para.split('\n').forEach((line, l) => {
      if (l > 0) units.push({ key: 'Enter', shift: true, times: 1 });
      for (const w of line.match(/\S+\s*|\s+/g) || []) units.push({ text: w });
    });
  });
  return units;
}

// ---------------------------------------------------------------------------
// Other fields on the page
// ---------------------------------------------------------------------------

/**
 * Record the value of every text field on the page except the reply box, so
 * anything typed into one by mistake can be put back. Pierces shadow roots
 * (Reddit's search lives in one). Marks each field with a data attribute.
 */
export async function snapshotOtherFields(page, editorHandle) {
  return page
    .evaluate((editor) => {
      const out = {};
      let n = 0;
      const inEditor = (el) => el === editor || (editor && (editor.contains(el) || el.contains(editor)));
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          const field = el.matches('input:not([type]), input[type="text"], input[type="search"], textarea, [contenteditable="true"]');
          if (!field || inEditor(el)) continue;
          const id = el.getAttribute('data-agent-field') || `f${(n += 1)}`;
          el.setAttribute('data-agent-field', id);
          out[id] = el.matches('input, textarea') ? el.value : el.textContent;
        }
      };
      walk(document);
      return out;
    }, editorHandle)
    .catch(() => ({}));
}

/** Put back any field whose value changed since the snapshot. Returns what was fixed. */
export async function restoreOtherFields(page, snapshot) {
  return page
    .evaluate((snap) => {
      const fixed = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('[data-agent-field]')) {
          const id = el.getAttribute('data-agent-field');
          if (!(id in snap)) continue;
          const isInput = el.matches('input, textarea');
          const now = isInput ? el.value : el.textContent;
          if (now === snap[id]) continue;
          const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName).slice(0, 40);
          if (isInput) {
            // The native setter, so frameworks that track value see the change.
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, snap[id]);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            el.textContent = snap[id];
          }
          el.blur();
          fixed.push({ label, stray: String(now).slice(0, 60) });
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return fixed;
    }, snapshot)
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// The typer
// ---------------------------------------------------------------------------

export class TypingAborted extends Error {}

/**
 * Type `text` into the box the caller has focused, a word at a time.
 *
 * opts:
 *   isFocused()      → is the caret in the reply box right now?
 *   refocus()        → put it back (click the box); the typer re-checks after
 *   dismissOverlays()→ close popups over the box (optional; called every few words)
 *   paragraphEnters  → Enters per blank line (2 for a markdown textarea)
 *   log
 *
 * Throws TypingAborted if focus cannot be restored or the page navigated away;
 * the caller must NOT submit then.
 */
export async function guardedType(page, text, { isFocused, refocus, dismissOverlays = async () => {}, paragraphEnters = 1, log = () => {} }) {
  const startUrl = page.url();
  const units = typingUnits(text, paragraphEnters);
  let refocused = 0;

  // Put the caret back in the box, or give up. Shared by the per-word and the
  // per-character check.
  const ensureFocus = async () => {
    if (await isFocused()) return;
    await dismissOverlays();
    await refocus();
    await sleep(rand(250, 500));
    if (!(await isFocused())) throw new TypingAborted('the caret left the reply box and could not be put back — stopped typing.');
    refocused += 1;
    log(`typing: the caret had left the reply box — put it back (${refocused}).`);
    if (refocused > 8) throw new TypingAborted('the caret kept leaving the reply box — stopped typing.');
  };

  for (let i = 0; i < units.length; i += 1) {
    if (i % 4 === 0) await dismissOverlays();
    if (page.url() !== startUrl) throw new TypingAborted(`the page navigated away while typing (to ${page.url()}) — stopped.`);

    const u = units[i];
    if (u.key) {
      await ensureFocus();
      for (let t = 0; t < u.times; t += 1) {
        if (u.shift) await page.keyboard.down('Shift');
        await page.keyboard.press(u.key);
        if (u.shift) await page.keyboard.up('Shift');
      }
      await sleep(rand(180, 450));
      continue;
    }
    // Focus is checked before EVERY character, not only every word: focus lost
    // mid-word otherwise sends the rest of the word nowhere (or to a shortcut —
    // a space scrolls, a "/" opens search). The check costs a millisecond
    // against a 30–110 ms keystroke.
    for (const ch of u.text) {
      await ensureFocus();
      await page.keyboard.type(ch, { delay: rand(30, 110) });
      if ('.!?'.includes(ch) && Math.random() < 0.35) await sleep(rand(400, 1300));
    }
    if (Math.random() < 0.06) await sleep(rand(300, 1000)); // a pause between words
  }
  return { refocused };
}

/**
 * Exact insertion, for the repair path — same focus guard, one line at a time.
 */
export async function guardedInsert(page, text, { isFocused, refocus, dismissOverlays = async () => {}, paragraphEnters = 1 }) {
  const cdp = await page.target().createCDPSession();
  try {
    for (const u of typingUnits(text, paragraphEnters)) {
      if (!(await isFocused())) {
        await dismissOverlays();
        await refocus();
        await sleep(300);
        if (!(await isFocused())) throw new TypingAborted('the caret left the reply box during the repair — stopped.');
      }
      if (u.key) {
        for (let t = 0; t < u.times; t += 1) {
          if (u.shift) await page.keyboard.down('Shift');
          await page.keyboard.press(u.key);
          if (u.shift) await page.keyboard.up('Shift');
        }
        await sleep(rand(80, 180));
      } else {
        await cdp.send('Input.insertText', { text: u.text });
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}
