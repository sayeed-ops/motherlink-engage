// Core domain types for Motherlink Engage.
//
// Two ideas drive this file, and both are departures from ML Studio:
//
// 1. PLATFORM IS DATA, NOT A NAME. ML Studio encodes Reddit in collection
//    prefixes (reddit_projects, reddit_posts, ...). Adding Quora there means a
//    parallel set of collections, a parallel set of rules, and a parallel set
//    of queries. Here a project holds modules, and every item carries a
//    `platform` discriminator, so a new platform is additive.
//
// 2. AUTHORIZATION IS TWO LAYERS. A global role says who you are on the
//    platform. Per-project permissions say what you may do for one client.
//    ML Studio has only the first, which is why any signed-in user can read
//    every client's data.

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** Reddit ships first. The rest are the reason the model is shaped this way. */
export type Platform = 'reddit' | 'quora' | 'linkedin';

export const PLATFORMS: readonly Platform[] = ['reddit', 'quora', 'linkedin'] as const;

/** Only Reddit is implemented. Guard against a half-built module going live. */
export const ENABLED_PLATFORMS: readonly Platform[] = ['reddit'] as const;

// ---------------------------------------------------------------------------
// Global role
// ---------------------------------------------------------------------------

/**
 * Platform-wide standing. Mirrored into a custom auth claim so security rules
 * can check it without a document read. Deliberately coarse: anything
 * client-specific belongs in Permission below.
 *
 * `tester` exists because there was nothing between `member` and `admin`.
 * Creating a project is platform-level — you cannot hold a permission on a
 * project that does not exist yet — so a tester who needs their own scratch
 * projects had to be made an admin, which also handed them warm-up, user
 * administration and the shared API keys. It is a role rather than a checkbox
 * because `globalPermissions` is derived from role at every write site.
 *
 * SAFE TO EXTEND: firestore.rules defines isPlatformAdmin() as an explicit
 * `owner || admin` allowlist, so any role added here is non-admin in the rules
 * with no change there. Add the role, give it a row in GLOBAL_ROLE_PERMISSIONS,
 * and that is the whole change.
 */
export type GlobalRole = 'owner' | 'admin' | 'member' | 'tester';

export const GLOBAL_ROLES: readonly GlobalRole[] = ['owner', 'admin', 'member', 'tester'] as const;

/** What each platform role may do beyond its project memberships.
 *
 *  THE one source of truth. Both write sites (api/users, api/users/[uid])
 *  previously inlined `role === 'owner' || role === 'admin' ? [...] : []`, which
 *  is exactly the kind of duplicated rule that drifts. */
export const GLOBAL_ROLE_PERMISSIONS: Record<GlobalRole, readonly GlobalPermission[]> = {
  owner: ['accounts.manage', 'projects.create'],
  admin: ['accounts.manage', 'projects.create'],
  /** Own scratch projects, and nothing else platform-wide. Notably NOT
   *  accounts.manage — warm-up and the posting identities stay out of reach. */
  tester: ['projects.create'],
  member: [],
};

export function globalPermissionsForRole(role: GlobalRole): GlobalPermission[] {
  return [...(GLOBAL_ROLE_PERMISSIONS[role] ?? [])];
}

/** Human-facing description of each platform role, for the People page. The
 *  dropdown used to show four bare words with no way to learn what they meant. */
export const GLOBAL_ROLE_META: Record<GlobalRole, string> = {
  owner: 'Everything, including making and unmaking other owners.',
  admin: 'Everything except owner changes: people, roles, accounts, shared API keys.',
  tester: 'Can create their own projects to test with. No accounts, warm-up, people or shared keys.',
  member: 'No platform powers. Access is granted per client, on that project.',
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Per-project permissions.
 *
 * The organising principle is NOT view-vs-edit. It is:
 *   free  ->  spends money  ->  touches the public internet
 * Those are the boundaries worth defending. `items.analyze` burns DeepSeek
 * credit; `items.fetch` burns metered residential proxy bandwidth;
 * `drafts.publish` puts words on the internet under a real Reddit account and
 * cannot be undone. Collapsing those into one "can use the tool" permission
 * would hide the only distinctions that matter.
 */
export const PERMISSIONS = [
  // --- free ---
  'project.view', // read the project, its items, analyses and drafts
  'project.edit', // change config: subreddits, keywords, forbidden phrases
  'project.members', // add/remove members, set their permissions
  'project.settings', // danger zone: clean history, delete project
  'knowledge.manage', // add/delete knowledge sources (these drive every analysis)
  'analytics.view', // read dashboards

  // --- spends money ---
  'items.fetch', // run fetch/search: consumes proxy bandwidth
  'items.analyze', // run analysis: consumes DeepSeek credit
  'drafts.generate', // generate a reply: consumes DeepSeek credit

  // --- touches the public internet ---
  'drafts.approve', // mark a draft approved (reversible)
  'drafts.publish', // queue a job. A real account posts. NOT reversible.

  // --- trains the model ---
  // Edit reasons from this holder become model-training data. Deliberately
  // narrow: anyone with drafts.generate can fix a draft, but only a train
  // holder's rationale is captured to teach the AI how to write next time.
  'drafts.train',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * UI metadata for each permission: a human label, the boundary group it belongs
 * to, and a one-line explanation. Drives the grouped checkbox editors used when
 * building a role or fine-tuning a single member's actions.
 */
export type PermissionGroup = 'free' | 'spend' | 'publish' | 'train';

export const PERMISSION_GROUP_LABELS: Record<PermissionGroup, string> = {
  free: 'Free — read & configure',
  spend: 'Spends money',
  publish: 'Touches the public internet',
  train: 'Trains the model',
};

export interface PermissionMeta {
  id: Permission;
  label: string;
  group: PermissionGroup;
  help: string;
}

export const PERMISSION_META: readonly PermissionMeta[] = [
  { id: 'project.view', label: 'View project', group: 'free', help: 'Read the project, its items, analyses and drafts.' },
  { id: 'project.edit', label: 'Edit config', group: 'free', help: 'Change subreddits, keywords and forbidden phrases.' },
  { id: 'project.members', label: 'Manage members', group: 'free', help: 'Add/remove members and set their permissions.' },
  { id: 'project.settings', label: 'Danger zone', group: 'free', help: 'Clean history and delete the project.' },
  { id: 'knowledge.manage', label: 'Manage knowledge', group: 'free', help: 'Add/delete the knowledge sources that drive analysis.' },
  { id: 'analytics.view', label: 'View analytics', group: 'free', help: 'Read the dashboards.' },
  { id: 'items.fetch', label: 'Fetch items', group: 'spend', help: 'Run fetch/search — consumes proxy bandwidth.' },
  { id: 'items.analyze', label: 'Analyse items', group: 'spend', help: 'Run analysis — consumes DeepSeek credit.' },
  { id: 'drafts.generate', label: 'Generate drafts', group: 'spend', help: 'Draft a reply — consumes DeepSeek credit.' },
  { id: 'drafts.approve', label: 'Approve drafts', group: 'publish', help: 'Mark a draft approved (reversible).' },
  { id: 'drafts.publish', label: 'Publish drafts', group: 'publish', help: 'Queue a post from a real account. NOT reversible.' },
  { id: 'drafts.train', label: 'Train the model', group: 'train', help: 'Their edit reasons become AI training data. Grant only to trusted writers.' },
] as const;

/**
 * Platform-global, not per-project.
 *
 * `accounts.manage` — one posting identity is used across many clients, so the
 * accounts and their warm-up cannot belong to any single project.
 *
 * `projects.create` — creating a project cannot be a project permission: there
 * is no project yet to hold it. The creator is added to their new project as
 * `manager`, so this grants a starting point, not standing access to anyone
 * else's client.
 *
 * Derived from GlobalRole, never set directly — see GLOBAL_ROLE_PERMISSIONS.
 */
export type GlobalPermission = 'accounts.manage' | 'projects.create';

/**
 * Named bundles for the admin UI.
 *
 * Assigning a bundle stores the EXPANDED array, never the bundle name. If a
 * bundle is later redefined, existing members keep what they were granted —
 * a preset edit must never silently widen access on live projects.
 */
export const PERMISSION_BUNDLES: Record<string, readonly Permission[]> = {
  /** Read-only. Can see the work, can spend nothing. */
  viewer: ['project.view', 'analytics.view'],

  /** Does the day-to-day: fetch, analyse, draft. Cannot publish. */
  analyst: [
    'project.view',
    'analytics.view',
    'knowledge.manage',
    'items.fetch',
    'items.analyze',
    'drafts.generate',
  ],

  /** Analyst plus the irreversible step. */
  approver: [
    'project.view',
    'analytics.view',
    'knowledge.manage',
    'items.fetch',
    'items.analyze',
    'drafts.generate',
    'drafts.approve',
    'drafts.publish',
  ],

  /**
   * Exercise the whole product against a client's data without being able to
   * do the two things a test run must never do.
   *
   * `drafts.publish` is excluded because it is not reversible — it posts from a
   * real Reddit account. `drafts.train` is excluded for the subtler reason: a
   * tester's throwaway edit reasons would become permanent AI training data,
   * and unlike a bad post there is nothing to see afterwards and nothing to
   * undo. Everything else, including the reversible `drafts.approve`, is in.
   */
  tester: PERMISSIONS.filter((p) => p !== 'drafts.publish' && p !== 'drafts.train'),

  /** Everything for one client, including membership and the danger zone. */
  manager: [...PERMISSIONS],
};

export type PermissionBundle = keyof typeof PERMISSION_BUNDLES;

export function expandBundle(bundle: PermissionBundle): Permission[] {
  return [...(PERMISSION_BUNDLES[bundle] ?? [])];
}

/** One-line descriptions for the built-in bundles, shown in the role pickers. */
export const BUILT_IN_ROLE_HELP: Record<PermissionBundle, string> = {
  viewer: 'Read the work. Cannot spend money or publish.',
  analyst: 'Fetch, analyse and draft. Cannot publish.',
  approver: 'Everything an analyst can do, plus approving and publishing.',
  tester: 'Exercise everything on this client except publishing and training the model.',
  manager: 'Full control of this client, including members and the danger zone.',
};

/**
 * A role as the pickers see it — the four built-ins (from code) and any custom
 * roles (from Firestore) share this shape. `builtIn` roles are granted by name
 * (`bundle`); custom roles are granted by `id` (`roleId`). Either way the member
 * document stores the EXPANDED permission array, never the role reference.
 */
export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  builtIn: boolean;
}

/** `roles/{roleId}` — an admin-defined, reusable per-project permission set. */
export interface CustomRole {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The built-in bundles rendered as RoleSummary, so pickers list one flat set. */
export function builtInRoles(): RoleSummary[] {
  return (Object.keys(PERMISSION_BUNDLES) as PermissionBundle[]).map((id) => ({
    id,
    name: id,
    description: BUILT_IN_ROLE_HELP[id] ?? '',
    permissions: [...PERMISSION_BUNDLES[id]],
    builtIn: true,
  }));
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// 'archived' is 'disabled' plus hidden from the default People list — a soft
// retirement for people who have left, so they stop cluttering the roster
// without losing the audit trail their uid anchors. Hard delete is separate.
export type UserStatus = 'active' | 'invited' | 'disabled' | 'archived';

/** `users/{uid}` */
export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: GlobalRole;
  status: UserStatus;
  /** Platform-global grants. Currently only accounts.manage. */
  globalPermissions: GlobalPermission[];
  /**
   * May this person spend the organisation's shared LLM keys?
   *
   * DEFAULT-ALLOW, and absent means true. Every user document written before
   * this field existed lacks it, and the intended default for them is exactly
   * the behaviour they already have — so the read is `!== false`, never
   * `=== true`, and there is no migration. Unchecking it writes an explicit
   * `false`; that person then falls through to their own key in
   * Settings → API keys, or to the platform key.
   *
   * Read it through `mayUseSharedKeys()` in server/auth.ts rather than touching
   * the field, so the absent-means-true rule lives in one place.
   */
  canUseSharedKeys?: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  /** Set when provisioned by an admin ahead of first sign-in. */
  invitedBy: string | null;
}

export type ProjectStatus = 'active' | 'archived';

/** `projects/{projectId}` — one client. */
export interface Project {
  projectId: string;
  name: string;
  clientWebsiteUrl: string;
  status: ProjectStatus;
  /** Which platform modules are live for this client. */
  enabledModules: Platform[];
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `projects/{projectId}/members/{uid}` — the authorization record.
 *
 * Not mirrored into custom claims: a user on 30 projects would exceed the
 * 1000-byte claim limit. Security rules read this document.
 */
export interface ProjectMember {
  uid: string;
  email: string;
  displayName: string;
  permissions: Permission[];
  /** The bundle this was created from, for display only. Never authoritative. */
  grantedFromBundle: string | null;
  grantedBy: string;
  grantedAt: Date;
}

/**
 * `projects/{projectId}/modules/reddit`
 *
 * Field-for-field the same as ML Studio's RedditProject, minus the identity
 * fields that moved up to Project. Keeping these identical is what makes
 * migration a re-parent rather than a transform, and keeps parity testable.
 */
export interface RedditModuleConfig {
  companyDescription: string;
  targetCustomer: string;
  productService: string;
  targetSubreddits: string[];
  keywords: string[];
  brandMentionStyle: string;
  forbiddenPhrases: string[];
  /** Which model scores posts, as a `provider:modelId` ref (see lib/llm).
   *
   *  `null` means "the platform default" — DeepSeek on the shared key, i.e.
   *  exactly what every project did before this setting existed. Storing null
   *  rather than the default string is what makes that distinction survive:
   *  a project that has never chosen keeps following the default if it moves. */
  analysisModel: string | null;
  /** Which model writes replies. Same null semantics. Unlike analysis this has
   *  no JSON-mode requirement, so more models qualify. */
  draftModel: string | null;
}
