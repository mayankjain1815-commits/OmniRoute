/**
 * POST /api/sync/cloud
 *
 * Control route for cloud sync. Remote sync workers (CLI / Electron) use it to
 * opt an instance in, push a config bundle upstream, or opt back out.
 *
 * `action` is a closed enum (`enable` | `sync` | `disable`) validated with
 * `validateBody` (Hard Rule #7 / gate T06) so an unknown action is a 400 rather
 * than a silent no-op.
 *
 * `enable` / `disable` only flip the `cloudEnabled` setting; the actual upstream
 * push happens on `sync` (and, for `enable`, is attempted immediately so the
 * caller learns straight away whether the configured CLOUD_URL is reachable).
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { cloudSyncActionSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { isCloudEnabled, updateSettings } from "@/lib/localDb";
import { CLOUD_URL, syncToCloud } from "@/lib/cloudSync";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }

  const validation = validateBody(cloudSyncActionSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { action } = validation.data;

  try {
    if (action === "enable") {
      await updateSettings({ cloudEnabled: true });
    } else if (action === "disable") {
      await updateSettings({ cloudEnabled: false });
      return NextResponse.json({ success: true, action, cloudEnabled: false });
    }

    // Both `enable` and an explicit `sync` push the bundle. Report the upstream
    // outcome without leaking the response body or any URL credentials.
    const machineId = await getConsistentMachineId();
    const synced = await syncToCloud(machineId);

    return NextResponse.json({
      success: true,
      action,
      cloudEnabled: await isCloudEnabled(),
      cloudUrlConfigured: Boolean(CLOUD_URL),
      synced: Boolean(synced),
    });
  } catch (error) {
    return createErrorResponse({
      status: 502,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}
