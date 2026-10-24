// Layer C — the shared plan executor.
//
// runPlan walks any itinerary (posting approach plan OR, later, a warm-up plan),
// dispatching each step to its Layer-B primitive. It owns the cross-cutting
// concerns so no individual primitive has to: per-step timeout, graceful abort
// (a wedged step fails the whole run rather than hanging or half-posting), and
// the human gap/jitter BETWEEN steps.
//
// Posting and warm-up differ ONLY in the plan they pass here.

import { ACTIONS, TERMINAL_TYPES } from './actions.mjs';
import { sleep, jitter, withTimeout, dismissBlockingOverlay, detectHumanCheck, HumanCheckError, CancelledError, setClickLog } from './helpers.mjs';

// Generous by design: a post_comment step navigates, opens the composer and types
// a ~1000-char comment at human speed (~80ms/char ≈ 90s) before it even reaches
// submit. 150s used to cut that close enough to abort mid-typing.
const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 300_000);

/**
 * Run an itinerary against an open page.
 * @param {import('puppeteer-core').Page} page
 * @param {Array<{type:string, params?:object, dwellSec?:number, gapAfterSec?:number, jitterPct?:number}>} plan
 * @param {{ log:Function } & Record<string, any>} ctx  shared context (expectedUsername, threadUrl, body, dryRun, …)
 * @returns {Promise<{ terminalResult:any, steps:number }>} terminalResult is the post_comment result (or null)
 */
// What a step ACTUALLY did, kept as a handful of scalars rather than the whole
// result object: small enough to store on the job forever, structured enough for
// the UI to render without knowing each primitive's internals. Anything a
// primitive doesn't report is simply absent.
const TRACE_FIELDS = [
  'via', // which search route actually landed / how the thread was reached
  // The route the PLAN aimed at, present only when it is not the one that
  // landed. Without it "Via communities" reads identically whether that was the
  // intention or a recovery from a route that has quietly stopped working —
  // which is how a broken surface stays invisible until it breaks everywhere.
  'plannedVia',
  'scrolls', // how many scrolls the hunt took
  'bursts',
  'read', // comments actually read
  'available', // comments there were to read
  'upvoted',
  // CONFIRMED from the button after the click, never merely attempted. The
  // dashboard reads this, and "we clicked Join" is a different fact from "the
  // account now follows it" — a click that silently failed must not display as a
  // membership, or the next session skips a community that was never joined.
  'joined',
  'subreddit', // which community a join / keyword search actually landed on
  'skipped',
  'reason',
  'seconds',
  'landed', // characters that made it into the composer
  'exact',
  'dryRun',
];

function traceOf(result) {
  const out = {};
  if (!result || typeof result !== 'object') return out;
  for (const key of TRACE_FIELDS) {
    const v = result[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[key] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** Throws HumanCheckError if a "prove you are human" check is on screen. */
async function haltOnHumanCheck(page) {
  const check = await detectHumanCheck(page);
  if (check) throw new HumanCheckError(check);
}

/** A promise that rejects the moment a human check appears, polled while a
 *  step runs — a step can take two minutes, and a check that arrives during it
 *  must stop the job then, not when the step happens to end. `stop()` ends it. */
function watchForHumanCheck(page, everyMs = 2500) {
  let timer = null;
  let stopped = false;
  const promise = new Promise((_, reject) => {
    const tick = async () => {
      if (stopped) return;
      const check = await detectHumanCheck(page);
      if (check && !stopped) return reject(new HumanCheckError(check));
      if (!stopped) timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, everyMs);
  });
  promise.catch(() => {}); // only ever observed through the race below
  return {
    promise,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export async function runPlan(page, plan, ctx) {
  const log = ctx.log || (() => {});
  // Popups the click guard closes are reported in this job's log.
  setClickLog(log);
  let terminalResult = null;
  // The record of what actually happened, step by step. A plan says what was
  // INTENDED; this says what the account really did — which route landed, whether
  // the post was found by browsing or reached directly, how many comments were
  // read, whether an upvote was skipped because it was already upvoted. Persisted
  // on the job so a posted reply keeps its history.
  const trace = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const fn = ACTIONS[step.type];
    if (!fn) {
      log(`plan step ${i + 1}/${plan.length} "${step.type}" has no primitive yet — skipping.`);
      trace.push({ type: step.type, ok: true, skipped: true, reason: 'not implemented by this agent' });
      continue;
    }

    // Cancelled from Engage: stop before the next step, and (raced below) in the
    // middle of a long one. `ctx.cancel` is only passed by jobs that can stop
    // cleanly part-way — warm-ups, which post nothing.
    if (ctx.cancel?.requested) throw Object.assign(new CancelledError(), { trace });

    log(`plan step ${i + 1}/${plan.length}: ${step.type}${step.params ? ` ${JSON.stringify(step.params)}` : ''}`);
    // A dialog over the page (a community's welcome guide after a join, an
    // achievement card) makes every step after it act on a page that cannot
    // respond. Looked for before EVERY step, because it appears on its own
    // schedule — usually as the result of the step before.
    //
    // A "prove you are human" check is looked for FIRST and is never closed:
    // it stops the whole run (HumanCheckError), here and at every point below.
    const urlBefore = page.url();
    let watch = null;
    const startedAt = Date.now();
    let result;
    try {
      await haltOnHumanCheck(page);
      await dismissBlockingOverlay(page, log);
      watch = watchForHumanCheck(page);
      result = await Promise.race(
        [withTimeout(fn(page, step, ctx), DEFAULT_STEP_TIMEOUT_MS, `step "${step.type}"`), watch.promise, ctx.cancel?.promise].filter(Boolean),
      );
      watch.stop();
      // A step that went to a new page: popups arrive a moment AFTER the page
      // does (a community's welcome card after a join or a visit), so the
      // check before the next step could run before it shows. Give it a beat.
      if (page.url() !== urlBefore) {
        await sleep(1800);
        await haltOnHumanCheck(page);
        await dismissBlockingOverlay(page, log);
      }
    } catch (e) {
      if (watch) watch.stop();
      if (e && e.humanCheck) {
        log(`HUMAN CHECK on step ${i + 1}/${plan.length} "${step.type}" — ${e.humanCheck.reason}: "${e.humanCheck.text}". Stopping here.`);
        trace.push({ type: step.type, ok: false, elapsedSec: Math.round((Date.now() - startedAt) / 1000), reason: 'human check' });
        throw Object.assign(e, { trace });
      }
      if (e && e.cancelled) {
        log(`cancelled on step ${i + 1}/${plan.length} "${step.type}" — stopping here.`);
        trace.push({ type: step.type, ok: false, elapsedSec: Math.round((Date.now() - startedAt) / 1000), reason: 'cancelled' });
        throw Object.assign(e, { trace });
      }
      // Graceful abort: surface which step broke; the caller fails the job. We
      // NEVER continue past a broken step (could post from a wrong state). The
      // trace rides along on the error so a FAILED job still records how far it
      // got — that's the half you most want when something breaks.
      trace.push({
        type: step.type,
        ok: false,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        reason: String(e.message || e).slice(0, 200),
      });
      throw Object.assign(new Error(`approach step "${step.type}" failed: ${e.message}`), { trace });
    }

    trace.push({
      type: step.type,
      ok: true,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      ...traceOf(result),
    });
    if (TERMINAL_TYPES.has(step.type)) terminalResult = result;

    // Human gap before the next step (skip after the last).
    if (i < plan.length - 1) {
      const gapMs = jitter(step.gapAfterSec ?? 1.5, step.jitterPct ?? 25) * 1000;
      await sleep(Math.max(300, gapMs));
    }
  }

  return { terminalResult, steps: plan.length, trace };
}
