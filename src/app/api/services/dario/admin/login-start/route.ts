/**
 * POST /api/services/dario/admin/login-start
 *
 * Forwards to the running Dario instance's POST /admin/login/start using the
 * stored admin token. Body: { alias?: string }. Returns Dario's
 * { alias, authorize_url, expires_at, instructions } to the browser — the
 * operator opens authorize_url, approves in their own Claude account, then
 * posts the displayed code to /login-complete.
 */

import { z } from "zod";
import { forwardToDarioAdmin, requireAdminAuth } from "../_lib";
import { createErrorResponse } from "@/lib/api/errorResponse";

const BodySchema = z
  .object({
    alias: z.string().max(200).optional(),
  })
  .default({});

export async function POST(request: Request): Promise<Response> {
  const authResponse = await requireAdminAuth(request);
  if (authResponse) return authResponse;

  let raw: unknown = {};
  if (request.body !== null) {
    try {
      raw = await request.json();
    } catch {
      return createErrorResponse({ status: 400, message: "Invalid JSON body" });
    }
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return createErrorResponse({ status: 400, message: parsed.error.message });
  }

  const alias = parsed.data.alias?.trim();
  const forwardBody = alias ? { alias } : {};
  return forwardToDarioAdmin({ method: "POST", path: "/admin/login/start", body: forwardBody });
}
