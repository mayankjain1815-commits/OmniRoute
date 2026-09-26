/**
 * POST /api/cloud/auth
 *
 * Verifies a Bearer API key and returns the masked provider-connection metadata
 * plus the model aliases, for cloud-sync clients that need to know what this
 * instance exposes before they push a bundle.
 *
 * Classified public in `src/shared/constants/publicApiRoutes.ts` (POST/OPTIONS):
 * it is the credential *verification* endpoint, and it is authenticated here with
 * a plain inference API key via `validateApiKey` rather than management auth.
 *
 * HARD RULE: this response must never contain a raw `apiKey` / `accessToken` /
 * `refreshToken`. It reports `hasApiKey` / `hasAccessToken` / `hasRefreshToken`
 * booleans plus a masked preview (first 4 + `****` + last 4) only.
 */

import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getModelAliases } from "@/models";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { maskSecret } from "../../models/alias/route";

type ConnectionRow = Record<string, unknown>;

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

  try {
    const connections = (await getProviderConnections()) as unknown as ConnectionRow[];

    const providers = connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      name: connection.name,
      email: connection.email,
      authType: connection.authType,
      isActive: connection.isActive,
      expiresAt: connection.expiresAt,
      hasApiKey: Boolean(connection.apiKey),
      hasAccessToken: Boolean(connection.accessToken),
      hasRefreshToken: Boolean(connection.refreshToken),
      maskedApiKey: maskSecret(connection.apiKey),
      maskedAccessToken: maskSecret(connection.accessToken),
    }));

    const aliases = await getModelAliases();

    return NextResponse.json({ success: true, providers, aliases });
  } catch (error) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}
