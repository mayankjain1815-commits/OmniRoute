/**
 * POST /api/cloud/model/resolve
 *
 * Resolves a logical model id / alias to a concrete `{ provider, model }` pair
 * using the local alias table and model registry, so a cloud-sync client can map
 * its own model names onto whatever this instance actually routes to.
 *
 * Classified public in `src/shared/constants/publicApiRoutes.ts` (POST/OPTIONS) —
 * a read-only lookup, authenticated with a plain inference API key. It leaks no
 * credentials: only the resolved provider/model identity comes back.
 */

import { NextResponse } from "next/server";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { cloudResolveAliasSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { resolveModelAliasLookup } from "@/lib/modelMetadataRegistry";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function POST(request: Request): Promise<Response> {
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (!apiKey) {
    return createErrorResponse({ status: 401, message: "Authentication required" });
  }

  let valid = false;
  try {
    valid = await isValidApiKey(apiKey);
  } catch {
    return createErrorResponse({ status: 503, message: "Service temporarily unavailable" });
  }
  if (!valid) {
    return createErrorResponse({ status: 401, message: "Invalid API key" });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }

  const validation = validateBody(cloudResolveAliasSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const resolved = await resolveModelAliasLookup(validation.data.alias);
    if (!resolved.ok) {
      return NextResponse.json(
        {
          error: {
            message: resolved.error.message,
            code: resolved.error.code,
            ...(resolved.error.candidates ? { candidates: resolved.error.candidates } : {}),
          },
        },
        { status: resolved.error.status }
      );
    }

    return NextResponse.json({
      alias: resolved.value.alias,
      provider: resolved.value.provider,
      model: resolved.value.model,
      resolvedAlias: resolved.value.resolvedAlias,
      source: resolved.value.source,
    });
  } catch (error) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}
