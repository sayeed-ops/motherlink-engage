// The empty Reddit module config — the shape a project has before anyone has
// filled in its settings.
//
// This lived in TWO places (the config route's GET fallback and the settings
// page's initial state) with no link between them. Adding a field to one and
// not the other is invisible until a project saves a config that silently drops
// it, so the constant is defined once here and imported by both.
//
// PURE by design — no 'server-only', no Firestore, no fetch — because one of the
// two consumers is a client component. Same convention as approach.ts and
// warmup.ts, which are deliberately isomorphic for the same reason.

import type { RedditModuleConfig } from '@/lib/types';

export const EMPTY_REDDIT_CONFIG: RedditModuleConfig = {
  companyDescription: '',
  targetCustomer: '',
  productService: '',
  targetSubreddits: [],
  keywords: [],
  brandMentionStyle: '',
  forbiddenPhrases: [],
  // null = platform default (DeepSeek on the shared key), which is what every
  // project did before the picker existed. No migration needed: an existing
  // config document simply has no such field, which reads back as undefined and
  // is treated the same as null everywhere.
  analysisModel: null,
  draftModel: null,
};
