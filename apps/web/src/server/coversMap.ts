import 'server-only';

// Building and storing the conversation map.
//
// Everything that decides anything is pure and lives in
// modules/covers/conversationMap.ts. This reads the analyses, makes the one
// model call that names the clusters, and writes the result.
//
// ⚠️ STORED IN ONE DOCUMENT, ON PURPOSE. The map is at most fifteen needs with a
// handful of strings each — comfortably inside a Firestore document, and one
// document is one read for the screen, one write for a rebuild, and one delete
// for the reset. A subcollection would buy per-need updates that nothing wants
// and cost a fan-out delete that the reset would have to get exactly right.

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { listTriage } from './coversTriage';
import {
  buildMapPrompt,
  candidateClusters,
  clusterConcepts,
  mapCounts,
  parseNeeds,
  EMPTY_MAP,
  MAP_PROMPT_VERSION,
  type ConversationMap,
  type MapInput,
} from '@/modules/covers/conversationMap';
import type { AskModel } from './coversTriage';

const project = (projectId: string) => adminDb().collection('projects').doc(projectId);
const mapRef = (projectId: string) => project(projectId).collection('modules').doc('coversMap');

export async function getConversationMap(projectId: string): Promise<ConversationMap> {
  const snap = await mapRef(projectId).get();
  if (!snap.exists) return EMPTY_MAP;
  return { ...EMPTY_MAP, ...(snap.data() as Partial<ConversationMap>) } as ConversationMap;
}

/**
 * Read every Covers analysis and reduce it to what the map cares about.
 *
 * Deliberately narrow: the map takes the intent and nothing else. It has no
 * business seeing which assets matched or which variants were eligible, because
 * those are facts about a CLIENT and the map describes the AUDIENCE.
 */
async function mapRows(projectId: string): Promise<MapInput[]> {
  const rows = await listTriage(projectId, { all: true, limit: 5000 });
  return rows.map((r) => ({
    postId: r.postId,
    itemId: r.itemId,
    section: r.section,
    outcome: r.outcome,
    intent: r.intent
      ? {
          intent: r.intent.intent,
          problem: r.intent.problem,
          concepts: r.intent.concepts,
          asksSomething: r.intent.asksSomething,
        }
      : null,
  }));
}

export interface BuildMapResult {
  map: ConversationMap;
  /** Clusters that cleared the recurrence floor and were offered to the model.
   *  Reported next to `needs.length` so a map of 6 from 14 candidates reads as
   *  selective rather than as a thin sample. */
  candidates: number;
  modelCalls: number;
}

/**
 * Build the map from what triage has already recorded.
 *
 * ONE MODEL CALL, and only to NAME clusters that arithmetic already found. The
 * clustering, the counts and the recurrence floor are free and deterministic;
 * the model is doing the one part arithmetic cannot, which is writing "Tracking
 * multi-leg bets" instead of "sgm · sgm legs · leg tracking".
 *
 * ⚠️ IT MAY RETURN FEWER NEEDS THAN CLUSTERS, AND THAT IS THE POINT. The prompt
 * offers an empty title as a way to reject a cluster, and `parseNeeds` honours
 * it. Six credible needs beat twelve manufactured ones — padding the map to a
 * round number is how a demo stops being evidence.
 */
export async function buildConversationMap(
  projectId: string,
  ask: AskModel,
): Promise<BuildMapResult> {
  const rows = await mapRows(projectId);
  const counts = mapCounts(rows);

  const allClusters = clusterConcepts(rows);
  const candidates = candidateClusters(rows);

  if (candidates.length === 0) {
    // No model call: there is nothing to name. Written anyway, so the screen can
    // say "we read 40 posts and found nothing recurring" rather than showing an
    // absent map that reads as a feature that never ran.
    const map: ConversationMap = {
      ...EMPTY_MAP,
      ...counts,
      clustersFound: allClusters.length,
      builtAtMs: Date.now(),
    };
    await saveConversationMap(projectId, map, '');
    return { map, candidates: 0, modelCalls: 0 };
  }

  const prompt = buildMapPrompt(candidates);
  const { content, model } = await ask({
    system: prompt.system,
    user: prompt.user,
    temperature: 0.2,
    maxTokens: 2400,
    json: true,
  });

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Left null: parseNeeds returns an empty array, which is honest — we found
    // clusters and could not name them, and the counts still say what was read.
  }

  const map: ConversationMap = {
    needs: parseNeeds(parsed, candidates),
    ...counts,
    clustersFound: allClusters.length,
    builtAtMs: Date.now(),
    model,
  };

  await saveConversationMap(projectId, map, model);
  return { map, candidates: candidates.length, modelCalls: 1 };
}

async function saveConversationMap(
  projectId: string,
  map: ConversationMap,
  model: string,
): Promise<void> {
  await mapRef(projectId).set(
    { ...map, model, promptVersion: MAP_PROMPT_VERSION, updatedAt: FieldValue.serverTimestamp() },
    { merge: false },
  );
}

/**
 * Delete the map.
 *
 * ⚠️ NOT PART OF A CLIENT-KNOWLEDGE RESET. The map describes the forum, not the
 * client — swapping the client changes nothing about it, and rebuilding it means
 * re-running triage, which is the expensive half of the pipeline. The reset
 * offers this as its own checkbox, defaulted OFF.
 */
export async function clearConversationMap(projectId: string): Promise<void> {
  await mapRef(projectId).delete();
}
