/**
 * GET /api/agent-skills/coverage
 *
 * Reports how many catalogued agent skills actually have a `skills/<id>/SKILL.md`
 * on disk, split by category (api / cli / config).
 *
 * Public and read-only — the aggregate exposes no file contents, only counts and
 * the timestamp of the computation.
 *
 * Note: `computeCoverage()` derives every total from the catalog id lists, so the
 * numbers cannot go stale as the catalog grows (hardcoded 23/20 previously did,
 * when cli-skill-collector was registered).
 */
import { NextResponse } from "next/server";

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { computeCoverage } from "@/lib/agentSkills/catalog";

// Catalog reads filesystem on demand — disable static caching
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(computeCoverage());
  } catch (error) {
    console.error("[API] GET /api/agent-skills/coverage error:", error);
    return NextResponse.json(buildErrorBody(500, "Failed to compute agent skills coverage"), {
      status: 500,
    });
  }
}
