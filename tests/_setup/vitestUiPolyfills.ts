// jsdom (unlike real browsers) does not implement `window.matchMedia`. Several
// dashboard components read the OS color-scheme preference via
// `window.matchMedia("(prefers-color-scheme: dark)")` (see
// `src/shared/hooks/useTheme.ts`), so any test that mounts a component using
// that hook (directly or transitively, e.g. via `ProviderIcon`) crashes with
// `TypeError: window.matchMedia is not a function` unless this polyfill runs
// first. Keep this minimal — it only needs to satisfy the subset of the
// MediaQueryList API this codebase actually calls.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql = {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
    return mql as unknown as MediaQueryList;
  };
}

// jsdom implements `scrollIntoView` as `undefined` (not a throwing stub, and not
// simply absent) — 7 dashboard components call it, e.g. ChatTab's
// "scroll to bottom on new messages" effect (`ChatTab.tsx:49`). Any test that
// actually renders one of them therefore dies with
// `TypeError: messagesEndRef.current?.scrollIntoView is not a function`.
//
// This only surfaced once the React-root cleanup below let the lazily-imported
// tabs actually mount: until then `next/dynamic` never resolved inside a test, so
// the affected components stayed behind their loading placeholder and the gap
// stayed invisible. A no-op is the right stub — the alternative (local
// per-file spies, as 8 test files currently carry) both duplicates this and
// misses the file that renders the component for the first time.
if (
  typeof window !== "undefined" &&
  typeof window.Element !== "undefined" &&
  typeof window.Element.prototype.scrollIntoView !== "function"
) {
  window.Element.prototype.scrollIntoView = function scrollIntoView() {
    // No-op: jsdom has no layout/scroll viewport, so there is nothing to scroll.
    // Returning undefined matches the real (void) signature.
  };
}

// #7935 wired `useTranslations`/`useLocale` (next-intl) into ~180 dashboard/shared
// components (Button, Modal, Select, EmptyState, ProviderIcon, ...). Any UI test that
// mounts a component depending on one of those — directly or transitively — without its
// own `vi.mock("next-intl", ...)` now crashes with "context from NextIntlClientProvider
// was not found". Rather than repeat a next-intl mock in dozens of test files, register
// one globally here, backed by the REAL `en.json` messages via next-intl's own
// `createTranslator` (imported from `use-intl/core`, which next-intl re-exports it from,
// so this module is never self-referential with the "next-intl" mock below). This makes
// `t(key, params)` render the actual production English copy — including ICU plural/
// select and ${param} interpolation — instead of a placeholder, so assertions on
// rendered text keep testing real behavior. A test file that declares its own
// `vi.mock("next-intl", ...)` still overrides this default for that file (Vitest applies
// the most specific / last-registered factory per module id).
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";
import { createTranslator } from "use-intl/core";
import en from "../../src/i18n/messages/en.json";

type Messages = Record<string, unknown>;

// Real next-intl's `useTranslations(namespace)` returns a REFERENTIALLY STABLE function
// across re-renders (it's memoized internally on locale/namespace/messages). Components
// routinely put `t` in a `useCallback`/`useEffect` dependency array (e.g.
// ClaudeClassifierCompatToggle's `load`/`cycle` callbacks). Returning a fresh closure on
// every call — as a naive mock does — breaks that memoization contract: the effect sees a
// "new" `t` every render and re-fires forever, hanging the test on a hidden infinite
// render loop instead of failing fast. Cache one translator per namespace so identity is
// stable, matching production.
const translatorCache = new Map<string, ReturnType<typeof createTranslator>>();

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => {
    const cacheKey = namespace ?? "";
    const cached = translatorCache.get(cacheKey);
    if (cached) return cached;
    const t = createTranslator({
      locale: "en",
      messages: en as Messages,
      namespace,
      onError: () => {
        // Swallow MISSING_MESSAGE noise — fall back to the key below, same as the
        // per-file `(key) => key` mocks this replaces for files with no local mock.
      },
      getMessageFallback: ({ key }) => key,
    });
    translatorCache.set(cacheKey, t);
    return t;
  },
  useLocale: () => "en",
  // A handful of tests (e.g. compressionCockpit.test.tsx, compressionHub*.test.tsx)
  // import the REAL `NextIntlClientProvider` to wrap the component under test — because
  // this file mocks the whole "next-intl" module, that import would otherwise resolve to
  // `undefined` and crash with "X is not a function". `useTranslations`/`useLocale` above
  // never read from React context (they call `createTranslator` directly), so the
  // provider only needs to render its children through — the `locale`/`messages` props
  // passed to it are inert here.
  NextIntlClientProvider: ({ children }: { children?: ReactNode }) => children,
}));

// ── React root lifecycle ──────────────────────────────────────────────────────
//
// ~57 UI test files call `createRoot(container)` and never call `root.unmount()` —
// they only `container.remove()` (or `document.body.innerHTML = ""`). Detaching the
// container leaves the React root LIVE: React's concurrent scheduler still has that
// root registered, and work it hands to the host scheduler (MessageChannel /
// setImmediate) runs as a separate macrotask. `act()` flushes React's own queue but
// not a macrotask already handed to the host, so that task survives the test and
// fires after Vitest tears down jsdom — at which point `window` no longer exists and
// it throws
//
//   ReferenceError: window is not defined
//     at performWorkOnRootViaSchedulerTask (react-dom-client.development.js)
//
// Vitest attributes an unhandled error to whichever test file owned the root and
// counts it as a RUN-LEVEL failure (non-zero exit even when every test passes). The
// attribution is timing-dependent, so the 198-file `test:vitest:ui` job failed on a
// different file each attempt — observed comboLiveStudio (12 errors), then
// providerCardHandle/flowCanvas/providerPageHeaderKimiPartnerLink/
// providerCardKimiPartnerAccent (2 each), then compressionCockpit (10) — which made it
// impossible to fix by chasing files. Fixing it per-file is also the wrong shape: the
// defect is structural, and 52 of the 57 files are one CI hiccup away from surfacing
// the same error.
//
// So fix it once, here: track every root the suite creates and unmount it in a global
// `afterEach`. Unmounting cancels the root's scheduled work, so nothing is left to fire
// after teardown. Hook order matters and is in our favour — Vitest runs `afterEach` LIFO
// and this file's hooks register before any test file's, so a test file's own cleanup
// (container removal) still runs FIRST and this is a backstop, not a behaviour change.
// Files that already unmount their own roots are unaffected: React's `unmount()` on an
// already-unmounted root is a no-op.
import type { Root } from "react-dom/client";

const liveRoots = new Set<Root>();

// Declared before the `vi.mock` call so it is initialised by the time the mock factory
// is first invoked (which happens when a test file imports react-dom/client).
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      liveRoots.add(root);
      return root;
    },
    hydrateRoot: (...args: Parameters<typeof actual.hydrateRoot>) => {
      const root = actual.hydrateRoot(...args);
      liveRoots.add(root);
      return root;
    },
  };
});

afterEach(async () => {
  if (liveRoots.size === 0) return;
  for (const root of liveRoots) {
    try {
      root.unmount();
    } catch {
      // A root whose container was already torn down (or a double unmount) is not a
      // test failure — the per-file afterEach hooks that detach containers have
      // already run. Swallowing here keeps the backstop from inventing failures.
    }
  }
  liveRoots.clear();

  // Unmounting ALONE is not sufficient, and this is worth being precise about why.
  // React's scheduler entry point does this as its very first statement:
  //
  //   function performWorkOnRootViaSchedulerTask(root, didTimeout) {
  //     nestedUpdateScheduled = currentUpdateIsNested = !1;
  //     schedulerEvent = window.event;          // <-- react-dom-client.development.js:20644
  //
  // It touches `window` unconditionally, BEFORE any check of whether `root` is still
  // live. React schedules that callback through `setImmediate` (Node's check phase),
  // which is not cancelled by `unmount()` and survives jsdom teardown — so a callback
  // already on the macrotask queue at teardown throws "window is not defined" even for
  // a root we correctly unmounted. Measured: the unmount backstop above alone took the
  // run from a failure in compressionCockpit down to a failure in comboLiveStudio (12
  // errors, real @xyflow/react scheduling work), which is the same error from a
  // different file, not a fix.
  //
  // So drain the macrotask queue here, while jsdom is still alive, and let those
  // hand-offs complete. Three ticks is enough for the scheduler's single deferred
  // callback (and anything it re-queues while unwinding an unmounted root).
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});
