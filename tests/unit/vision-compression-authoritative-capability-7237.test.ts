/**
 * #7237 — vision-capable models lose image_url blocks under compression.
 *
 * `open-sse/handlers/chatCore.ts` fed `applyCompressionAsync`'s `supportsVision` option
 * from `isVisionModelId(effectiveModel)` — the deliberately-conservative model-id
 * fragment heuristic in `src/shared/constants/visionModels.ts` — instead of the
 * authoritative `getResolvedModelCapabilities().supportsVision` that every other
 * vision-aware code path (e.g. the vision-bridge guardrail) uses.
 *
 * `gpt-5.5` is the originally-reported instance: registered with `supportsVision: true`
 * in `src/shared/constants/modelSpecs.ts`, but at the time the fragment list had no
 * gpt-5 entry, so the heuristic returned `false`.
 * `open-sse/services/compression/lite.ts::replaceImageUrls()` gates on
 * `supportsVision !== false`, so that spurious `false` made it silently strip every
 * `image_url` block from the request before it ever reached the executor.
 *
 * The witnesses are DERIVED, not hardcoded. The `gpt-5` fragment was later added to
 * the heuristic, which closed that particular gap — and silently turned this test's
 * hardcoded `gpt-5.5` assertions into a stale snapshot that no longer exercised the
 * drift it was written to pin. The bug class is not gone: several registered models
 * still declare `supportsVision: true` in modelSpecs.ts while the fragment heuristic
 * reports `false` for them, and any of them would reproduce #7237 identically.
 *
 * So: find the live disagreement, and assert over it. If the list ever empties, the
 * heuristic has caught up with the spec and this test must be re-pointed at whatever
 * the authoritative source is then — the explicit non-empty assertion makes that
 * visible instead of letting the test pass vacuously.
 *
 * This test asserts the CORRECT, authoritative-capability-driven behavior: a
 * vision-capable model keeps its images through the lite-compression path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isVisionModelId } from "../../src/shared/constants/visionModels.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";
import { replaceImageUrls } from "../../open-sse/services/compression/lite.ts";
import { applyCompressionAsync } from "../../open-sse/services/compression/strategySelector.ts";

/** The model originally reported in #7237, still asserted against the authoritative spec. */
const REPORTED_MODEL = "gpt-5.5";

function imageBody() {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
      },
    ],
  };
}

function specSupportsVision(model: string): boolean | undefined {
  try {
    return getResolvedModelCapabilities({ model }).supportsVision;
  } catch {
    return undefined;
  }
}

/**
 * Registered models the authoritative spec calls vision-capable but the conservative
 * id-fragment heuristic does not recognize — the exact shape of the #7237 bug.
 */
function findDriftWitnesses(): string[] {
  return Object.keys(MODEL_SPECS).filter(
    (id) => specSupportsVision(id) === true && !isVisionModelId(id)
  );
}

describe("#7237 vision-capable models keep their images through compression", () => {
  it("documents the drift: the conservative id-fragment heuristic still disagrees with the authoritative spec", () => {
    const witnesses = findDriftWitnesses();

    // A hardcoded witness list silently rots the moment the heuristic improves —
    // that is exactly how this file went stale on main. Fail loudly instead, so the
    // next person to close the gap is told to re-point the test rather than to
    // delete it.
    assert.ok(
      witnesses.length > 0,
      "no model currently disagrees between the id-fragment heuristic and modelSpecs.ts. " +
        "The #7237 bug class is no longer reproducible through MODEL_SPECS — re-point this " +
        "suite at whatever model still exposes the heuristic-vs-spec disagreement."
    );

    for (const id of witnesses) {
      assert.equal(
        isVisionModelId(id),
        false,
        `${id}: the fragment-list heuristic must report non-vision — it is a deliberately ` +
          "conservative fallback, not the source of truth"
      );
      assert.equal(
        specSupportsVision(id),
        true,
        `${id}: modelSpecs.ts registers it with supportsVision:true — this is the ` +
          "authoritative source chatCore must use"
      );
    }
  });

  it("the originally-reported model stays vision-capable in the authoritative spec", () => {
    assert.equal(
      specSupportsVision(REPORTED_MODEL),
      true,
      `${REPORTED_MODEL} is registered with supportsVision:true in modelSpecs.ts`
    );
  });

  it("replaceImageUrls preserves the image when fed the authoritative capability (the fixed chatCore.ts:1330 behavior)", () => {
    for (const model of findDriftWitnesses()) {
      const result = replaceImageUrls(imageBody(), {
        supportsVision: specSupportsVision(model),
      });
      assert.equal(result.applied, false, `${model}: the image must be KEPT, not stripped`);
      const content = result.body.messages?.[0]?.content as Array<Record<string, unknown>>;
      assert.equal(
        content[0].type,
        "image_url",
        `${model}: the block must remain a real image_url block`
      );
    }
  });

  it("regresses the pre-fix bug: feeding the raw heuristic value strips the image", () => {
    for (const model of findDriftWitnesses()) {
      const buggyValue = isVisionModelId(model); // false — the pre-fix chatCore.ts:1330 input
      const result = replaceImageUrls(imageBody(), { supportsVision: buggyValue });
      assert.equal(
        result.applied,
        true,
        `${model}: sanity check — this reproduces the bug shape when fed the wrong (heuristic) value`
      );
    }
  });

  it("applyCompressionAsync end-to-end (lite mode) keeps image_url blocks when fed the authoritative capability", async () => {
    for (const model of findDriftWitnesses()) {
      const result = await applyCompressionAsync(imageBody(), "lite", {
        model,
        supportsVision: specSupportsVision(model),
      });
      const content = (result.body as { messages: Array<{ content: unknown }> }).messages[0]
        .content as Array<Record<string, unknown>>;
      assert.equal(content[0].type, "image_url", `${model} must keep its image_url block intact`);
      assert.equal(
        (content[0].image_url as Record<string, unknown>)?.url,
        "data:image/png;base64,iVBOR",
        `${model}: the original data URL must survive unchanged`
      );
    }
  });
});
