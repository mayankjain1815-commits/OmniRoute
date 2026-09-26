import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
// Import the barrel, NOT ./manager: src/lib/memory/index.ts registers the
// sqlite backend with memoryManager as a module side effect, while ./manager on
// its own does not. Importing the submodule made this route depend on some
// unrelated module having loaded the barrel first — in production
// src/instrumentation-node.ts does it via initMemoryBackends(), so the endpoint
// happened to work, but any context where instrumentation had not run got a
// 500 "[MemoryManager] Primary backend \"sqlite\" not registered".
// Sibling route src/app/api/memory/route.ts already imports the barrel.
import { memoryManager } from "@/lib/memory";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { MemoryUpdatePutSchema } from "@/shared/schemas/memory";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await props.params;
    const success = await memoryManager.delete(id);
    if (!success) {
      return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await props.params;
    const memory = await memoryManager.get(id);
    if (!memory) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ memory });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", details: [] } },
      { status: 400 }
    );
  }

  const validation = validateBody(MemoryUpdatePutSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  try {
    const { id } = await props.params;
    const existing = await memoryManager.get(id);
    if (!existing) {
      return NextResponse.json({ error: { message: "Memory not found" } }, { status: 404 });
    }

    await memoryManager.update(id, validation.data);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
