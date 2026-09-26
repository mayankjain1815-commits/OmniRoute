/**
 * GET /api/cloud/models/alias — list every model alias exposed to cloud sync
 * PUT /api/cloud/models/alias — set a model alias (auto-syncs to Cloud if enabled)
 *
 * Security notes:
 *   - The GET (read) variant is classified public-readonly in
 *     `src/shared/constants/publicApiRoutes.ts`, matching the #6233 split where
 *     cloud read/auth routes stay public and only the mutable routes moved behind
 *     management auth.
 *   - The PUT (write) variant is the mutable one: it requires management auth with
 *     the `manage` scope. A missing/invalid key is 401 so both cloud write routes
 *     answer identically; a valid key without `manage` gets 403.
 *   - Body is validated with `validateBody` (Hard Rule #7 / gate T06).
 */

import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, isCloudEnabled } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { cloudModelAliasUpdateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

/**
 * Mask a secret for display: first 4 + `****` + last 4. Never returns a full
 * token — `/api/cloud/auth` relies on this and must not leak credentials.
 */
export function maskSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export async function GET(): Promise<Response> {
  try {
    const aliases = await getModelAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request, {
    alwaysRequireAuth: true,
    invalidApiKeyStatus: 401,
  });
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }

  const validation = validateBody(cloudModelAliasUpdateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { model, alias } = validation.data;

  try {
    await setModelAlias(alias, model);
    await syncToCloudIfEnabled();
    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}

async function syncToCloudIfEnabled(): Promise<void> {
  try {
    if (!(await isCloudEnabled())) return;
    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.error(
      "[cloud/models/alias] cloud sync after alias update failed:",
      sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
    );
  }
}
