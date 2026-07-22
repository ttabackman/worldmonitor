/**
 * Frontend entitlement service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time entitlement
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 */

import { getConvexClient, getConvexApi, waitForConvexAuth } from './convex-client';

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    planLimits?: {
      apiRequestsPerDay: number | null;
      apiBurstRequestsPerMinute: number | null;
      mcpCallsPerDay: number | null;
      mcpBurstRequestsPerMinute: number | null;
    };
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    /**
     * Pro MCP access (plan 2026-05-10-001). Undefined on legacy entitlement
     * snapshots that pre-date the catalog field. `hasFeature('mcpAccess')`
     * coerces undefined → false via Boolean(), so the settings tab
     * fails-closed for unrefreshed Pro users (they'll see it appear once
     * Dodo's next webhook repopulates the field).
     */
    mcpAccess?: boolean;
  };
  validUntil: number;
}

/**
 * Fork override: local self-hosted build unlocks all premium features without
 * payment. This synthetic max-tier state is returned by all read paths below,
 * so every panel/feature gate resolves as fully entitled. The Convex
 * subscription machinery is left intact but its result is not gated on.
 * To restore the original paywall behaviour, delete UNLOCKED_STATE and the
 * short-circuits marked "Fork override" in the getters below.
 */
const UNLOCKED_STATE: EntitlementState = {
  planKey: 'unlocked',
  features: {
    tier: 999,
    apiAccess: true,
    apiRateLimit: Number.MAX_SAFE_INTEGER,
    planLimits: {
      apiRequestsPerDay: null,
      apiBurstRequestsPerMinute: null,
      mcpCallsPerDay: null,
      mcpBurstRequestsPerMinute: null,
    },
    maxDashboards: Number.MAX_SAFE_INTEGER,
    prioritySupport: true,
    exportFormats: ['json', 'csv', 'pdf', 'png', 'xlsx'],
    mcpAccess: true,
  },
  validUntil: Number.MAX_SAFE_INTEGER,
};

// Module-level state
let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let initialized = false;
let unsubscribeFn: (() => void) | null = null;

/**
 * Initialize the entitlement subscription for the authenticated user.
 * Idempotent — calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initEntitlementSubscription(_userId?: string): Promise<void> {
  if (initialized) return;

  try {
    const client = await getConvexClient();
    if (!client) {
      console.log('[entitlements] No VITE_CONVEX_URL — skipping Convex subscription');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      console.log('[entitlements] Could not load Convex API — skipping subscription');
      return;
    }

    // Wait for Convex to confirm auth before subscribing. Otherwise the first
    // getEntitlementsForUser snapshot runs unauthenticated and returns
    // FREE_TIER_DEFAULTS, which can race with the post-payment panel gating
    // decision (the UI renders as free before the auth-ready pro snapshot
    // arrives). Unauthenticated visitors time out after 10s and we skip the
    // subscription entirely — they don't need entitlement updates.
    const authed = await waitForConvexAuth(10_000);
    if (!authed) {
      console.log('[entitlements] Convex auth not established — skipping subscription');
      return;
    }

    const watch = client.onUpdate(
      api.entitlements.getEntitlementsForUser,
      {},
      (result: EntitlementState | null) => {
        currentState = result;
        for (const cb of listeners) cb(result);
      },
      (err: Error) => {
        console.warn('[entitlements] Subscription query error:', err.message);
      },
    );

    unsubscribeFn = watch.unsubscribe;
    initialized = true;
  } catch (err) {
    console.error('[entitlements] Failed to initialize Convex subscription:', err);
    // Do not rethrow — entitlement service failure must not break the dashboard
  }
}

/**
 * Tears down the entitlement subscription and clears all listeners.
 * Resets initialized flag so a new subscription can be started.
 * Does NOT null currentState — preserves the last known state across
 * destroy/reinit cycles (e.g. WebSocket reconnects) so paying users don't
 * see locked panels during backoff. Call resetEntitlementState() on sign-out.
 */
export function destroyEntitlementSubscription(): void {
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }
  // Keep listeners intact — PanelLayout registers them once and expects them
  // to survive auth transitions. Only the Convex transport is torn down.
  initialized = false;
}

/**
 * Explicitly nulls currentState. Call on sign-out to prevent the previous
 * user's entitlements from leaking into a subsequent session.
 * Distinct from destroyEntitlementSubscription() which preserves state for reconnects.
 */
export function resetEntitlementState(): void {
  currentState = null;
}

/**
 * Register a callback for entitlement changes.
 * If entitlement state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onEntitlementChange(
  cb: (state: EntitlementState | null) => void,
): () => void {
  listeners.add(cb);

  // Late subscribers get the current value immediately
  if (currentState !== null) {
    cb(currentState);
  }

  return () => {
    listeners.delete(cb);
  };
}

/**
 * Returns the current entitlement state, or null if not yet loaded.
 */
export function getEntitlementState(): EntitlementState | null {
  // Fork override: always report the unlocked state.
  return UNLOCKED_STATE;
}

/**
 * Check whether a specific feature flag is truthy in the current entitlement state.
 */
export function hasFeature(flag: keyof EntitlementState['features']): boolean {
  // Fork override: all features unlocked.
  return Boolean(UNLOCKED_STATE.features[flag]);
}

/**
 * Check whether the user's tier meets or exceeds the given minimum.
 */
export function hasTier(minTier: number): boolean {
  // Fork override: always meets any tier requirement.
  return UNLOCKED_STATE.features.tier >= minTier;
}

/**
 * Simple "is this a paying user" check.
 * Returns true if entitlement data exists, plan is not free, and hasn't expired.
 */
export function isEntitled(): boolean {
  // Fork override: always entitled.
  return true;
}

/**
 * Decides whether to reload the page when an entitlement snapshot arrives.
 *
 * Rules:
 *   - First snapshot ever (last === null): never reload. A legacy-pro user
 *     whose first snapshot is already `true` must not trigger a reload loop
 *     on every page load.
 *   - Free → pro transition (last === false, next === true): reload. This is
 *     the post-payment activation case — panels rendered against free-tier
 *     gating need to re-render to pick up the new entitlement.
 *   - Everything else (free→free, pro→pro, pro→free): no reload.
 */
export function shouldReloadOnEntitlementChange(
  last: boolean | null,
  next: boolean,
): boolean {
  return last === false && next === true;
}
