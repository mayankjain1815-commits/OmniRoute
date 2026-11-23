/**
 * Shared constants for the Antigravity model-discovery route tests.
 *
 * Extracted so `provider-models-route.test.ts` stays under its frozen size cap
 * (`config/quality/file-size-baseline.json`). The route's discovery flow calls
 * these two endpoints as a project bootstrap BEFORE any discovery endpoint, so a
 * mock that lets them fall through to its own 503 budget consumes that budget on
 * a call the test does not mean to assert on.
 */

/**
 * True for a bootstrap call the Antigravity discovery flow makes before it
 * reaches a real discovery endpoint.
 *
 * After PR #2219 the order is `loadCodeAssist` then `onboardUser`. Handling only
 * the first was a live bug in the test, not in the route: `onboardUser` fell
 * through to the shared mock, ate its one-shot 503, and the first
 * `:fetchAvailableModels` then answered 200 — so discovery returned early, the
 * retry never ran, and the test asserted a two-URL sequence the route had no
 * reason to produce.
 */
export function isAntigravityBootstrapCall(url: string): boolean {
  return url.includes("/v1internal:loadCodeAssist") || url.includes("/v1internal:onboardUser");
}
