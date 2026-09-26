/**
 * PUT /api/cloud/credentials/update
 *
 * Refreshes the stored OAuth credentials of a cloud-synced provider connection.
 * Called by remote cloud-sync clients (CLI / Electron / sync workers) after they
 * complete a token refresh out-of-band, so the local Provider Connection row does
 * not hold an expired access token.
 *
 * Security notes:
 *   - This is a MUTABLE cloud route, so it requires management auth with the
 *     `manage` scope (a plain inference API key is rejected with 403). A missing
 *     or invalid key is 401, matching the sibling /api/cloud/models/alias route.
 *   - Credential values are never echoed in the response body nor written to the
 *     log. Only connection ids and the provider id come back.
 *   - Body is validated with `validateBody` (Hard Rule #7 / gate T06).
 */

import { NextResponse } from "next/server";
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { cloudCredentialUpdateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

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

  const validation = validateBody(cloudCredentialUpdateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { provider, credentials } = validation.data;

  try {
    const connections = (await getProviderConnections({
      provider,
      isActive: true,
    })) as unknown as Array<Record<string, unknown>>;

    const targets = connections.filter((connection) => typeof connection.id === "string");
    if (targets.length === 0) {
      return createErrorResponse({
        status: 404,
        message: `No active connection found for provider '${provider}'`,
      });
    }

    // Build the update from only the fields the client actually sent, so a
    // refresh-token-only call never blanks the stored access token.
    const updates: Record<string, unknown> = {};
    if (credentials.accessToken !== undefined) updates.accessToken = credentials.accessToken;
    if (credentials.refreshToken !== undefined) updates.refreshToken = credentials.refreshToken;
    if (credentials.expiresIn !== undefined) {
      updates.expiresAt = new Date(Date.now() + credentials.expiresIn * 1000).toISOString();
    }

    const updatedConnections: string[] = [];
    for (const connection of targets) {
      await updateProviderConnection(String(connection.id), { ...updates });
      updatedConnections.push(String(connection.id));
    }

    return NextResponse.json({
      success: true,
      provider,
      updatedConnections: updatedConnections.length,
    });
  } catch (error) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}
