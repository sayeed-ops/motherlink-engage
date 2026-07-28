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
import { sleep, jitter, withTimeout } from './helpers.mjs';

const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 90_000);

/**
 * Run an itinerary against an open page.
 * @param {import('puppeteer-core').Page} page
 * @param {Array<{type:string, params?:object, dwellSec?:number, gapAfterSec?:number, jitterPct?:number}>} plan
 * @param {{ log:Function } & Record<string, any>} ctx  shared context (expectedUsername, threadUrl, body, dryRun, …)
 * @returns {Promise<{ terminalResult:any, steps:number }>} terminalResult is the post_comment result (or null)
 */
export async function runPlan(page, plan, ctx) {
  const log = ctx.log || (() => {});
  let terminalResult = null;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const fn = ACTIONS[step.type];
    if (!fn) {
      log(`plan step ${i + 1}/${plan.length} "${step.type}" has no primitive yet — skipping.`);
      continue;
    }

    log(`plan step ${i + 1}/${plan.length}: ${step.type}${step.params ? ` ${JSON.stringify(step.params)}` : ''}`);
    let result;
    try {
      result = await withTimeout(fn(page, step, ctx), DEFAULT_STEP_TIMEOUT_MS, `step "${step.type}"`);
    } catch (e) {
      // Graceful abort: surface which step broke; the caller fails the job. We
      // NEVER continue past a broken step (could post from a wrong state).
      throw new Error(`approach step "${step.type}" failed: ${e.message}`);
    }

    if (TERMINAL_TYPES.has(step.type)) terminalResult = result;

    // Human gap before the next step (skip after the last).
    if (i < plan.length - 1) {
      const gapMs = jitter(step.gapAfterSec ?? 1.5, step.jitterPct ?? 25) * 1000;
      await sleep(Math.max(300, gapMs));
    }
  }

  return { terminalResult, steps: plan.length };
}
