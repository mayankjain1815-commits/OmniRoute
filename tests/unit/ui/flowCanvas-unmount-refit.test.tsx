// @vitest-environment jsdom
/**
 * Regression: FlowCanvas queued its deferred auto-fit from `onInit` with a bare
 * `setTimeout(...)` whose id was never kept, so the timer outlived the component.
 *
 * The generation counter next to it only guards a *replaced* ReactFlow instance
 * (`generationRef.current === generation`), not an unmounted one. So unmounting
 * within the 60ms window — navigating away, switching studio tabs, any parent
 * that drops the canvas — left the timer to fire afterwards and call
 * `instance.fitView()` on a dead instance. React Flow's `fitView` dispatches
 * state, which lands in `requestUpdateLane` -> `resolveUpdatePriority` and reads
 * `window`. In the dashboard that is a stray setState against a dead root; in the
 * `test:vitest:ui` job it is an unhandled "ReferenceError: window is not defined"
 * raised after jsdom teardown, which fails the whole 198-file run on an
 * attribution that moves from file to file.
 *
 * `@xyflow/react` is stubbed here so the test can capture the `onInit` prop
 * FlowCanvas hands to `<ReactFlow>` and drive it with a fake instance. The
 * sibling flowCanvas.test.tsx keeps the real ReactFlow for the DOM assertions —
 * the two cover different layers and both need to exist.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fitView, captured } = vi.hoisted(() => ({
  fitView: vi.fn(),
  captured: { onInit: null as ((instance: unknown) => void) | null },
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: { onInit?: (instance: unknown) => void }) => {
    captured.onInit = props.onInit ?? null;
    return <div data-testid="react-flow-stub" />;
  },
  Controls: () => null,
}));

const { FlowCanvas } = await import("@/shared/components/flow/FlowCanvas");

// FlowCanvas observes its container directly, and jsdom has no ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const nodes = [{ id: "a", position: { x: 0, y: 0 }, data: { label: "A" } }];
const edges: Array<{ id: string; source: string; target: string }> = [];

// REFIT_DELAY_MS in FlowCanvas.tsx, plus slack.
const PAST_REFIT_DELAY = 200;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function renderCanvas() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<FlowCanvas nodes={nodes} edges={edges} />);
  });
  expect(captured.onInit).toBeTypeOf("function");
  act(() => {
    captured.onInit?.({ fitView });
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fitView.mockClear();
  captured.onInit = null;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  if (container) {
    document.body.removeChild(container);
    container = null;
  }
  vi.useRealTimers();
});

describe("FlowCanvas — deferred auto-fit lifecycle", () => {
  // Positive control: proves the fake timers actually reach the deferred fitView,
  // so the negative case below cannot pass just because fitView is never wired up.
  it("performs the deferred fitView while the canvas stays mounted", () => {
    renderCanvas();
    expect(fitView).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(PAST_REFIT_DELAY);
    });

    expect(fitView).toHaveBeenCalledTimes(1);
  });

  it("cancels the deferred fitView when unmounted before the timer fires", () => {
    renderCanvas();

    act(() => root?.unmount());
    root = null;

    act(() => {
      vi.advanceTimersByTime(PAST_REFIT_DELAY);
    });

    expect(fitView).not.toHaveBeenCalled();
  });

  it("keeps only the latest instance's pending refit when re-initialised", () => {
    renderCanvas();

    // A second onInit (a fitKey-driven remount) must drop the first instance's
    // queued refit rather than fitting both.
    const stale = vi.fn();
    const current = vi.fn();
    const secondOnInit = captured.onInit;
    act(() => secondOnInit?.({ fitView: stale }));
    act(() => secondOnInit?.({ fitView: current }));

    act(() => {
      vi.advanceTimersByTime(PAST_REFIT_DELAY);
    });

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(fitView).not.toHaveBeenCalled();
  });

  // ReactFlow's onInit fires from an internal viewport/observer callback, not
  // synchronously during render, so it can arrive AFTER unmount. Cancelling in
  // the unmount cleanup is not enough there — the cleanup has already run by the
  // time the timer exists — so the fire-time mount check is what saves it.
  it("drops a refit queued by an onInit that arrives after unmount", () => {
    const late = vi.fn();
    // Mounted, then unmounted, and only now does ReactFlow report its instance.
    renderCanvas();
    // Read the prop AFTER render — `renderCanvas` is what captures it, and
    // beforeEach resets it to null.
    const onInit = captured.onInit;
    expect(onInit).toBeTypeOf("function");

    act(() => root?.unmount());
    root = null;

    act(() => onInit?.({ fitView: late }));
    act(() => {
      vi.advanceTimersByTime(PAST_REFIT_DELAY);
    });

    expect(late).not.toHaveBeenCalled();
  });
});
