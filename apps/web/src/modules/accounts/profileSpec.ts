import type { ParsedProxy } from './proxy';

// What a new AdsPower browser profile is made of, and the exact request body
// AdsPower's Local API takes to create it (POST /api/v2/browser-profile/create —
// field names from AdsPower's own local-api reference).
//
// Built here, in Engage, and handed to the agent as-is: the agent only relays
// it to AdsPower on the server, so the rules below live in one tested place.
//
// The rules, as the operator set them (2026-10-25):
//   - browser: the operator's choice, always the newest version AdsPower has;
//   - OS: random per profile, but only systems ordinary people browse from —
//     Windows or macOS, never Linux, Android or iOS. AdsPower picks the OS of
//     the machine it runs on when none is named, which would make every profile
//     Windows, so the list is always sent;
//   - time zone, location and language follow the proxy's IP, and WebRTC goes
//     through the proxy, so the browser and its IP tell the same story.

export type BrowserKind = 'chrome' | 'firefox';
export type OsChoice = 'any' | 'windows' | 'mac';

export const BROWSER_LABEL: Record<BrowserKind, string> = {
  chrome: 'SunBrowser (Chrome)',
  firefox: 'FlowerBrowser (Firefox)',
};

export const OS_LABEL: Record<OsChoice, string> = {
  any: 'Windows or Mac (random)',
  windows: 'Windows only',
  mac: 'Mac only',
};

const WINDOWS = ['Windows 10', 'Windows 11'];
const MAC = ['Mac OS X 13', 'Mac OS X 14', 'Mac OS X 15'];

export function uaSystemVersions(os: OsChoice): string[] {
  return os === 'windows' ? WINDOWS : os === 'mac' ? MAC : [...WINDOWS, ...MAC];
}

export interface ProfileSpec {
  name: string;
  /** AdsPower group id; '0' is AdsPower's ungrouped. */
  groupId: string;
  browser: BrowserKind;
  os: OsChoice;
  /** Copied into the profile's remark word for word. */
  remark: string;
}

/** AdsPower caps a remark; past this it refuses the whole create. */
export const REMARK_MAX = 1500;

export function adsPowerCreateBody(spec: ProfileSpec, proxy: ParsedProxy): Record<string, unknown> {
  return {
    name: spec.name.trim().slice(0, 100),
    group_id: spec.groupId || '0',
    remark: spec.remark.slice(0, REMARK_MAX),
    user_proxy_config: {
      proxy_soft: 'other',
      proxy_type: proxy.type,
      proxy_host: proxy.host,
      proxy_port: String(proxy.port),
      proxy_user: proxy.user,
      proxy_password: proxy.password,
    },
    fingerprint_config: {
      automatic_timezone: '1',
      location_switch: '1',
      language_switch: '1',
      webrtc: 'proxy',
      browser_kernel_config: { type: spec.browser, version: 'ua_auto' },
      random_ua: { ua_system_version: uaSystemVersions(spec.os) },
    },
  };
}
