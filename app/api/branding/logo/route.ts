import { getPublicFileStore } from "@/lib/storage/public-store";
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions";
import { BRANDING_LOGO_MAX_BYTES, brandingLogoPathname, sniffBrandingLogoType } from "@/lib/branding-logo";
import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

/**
 * Uploads a workspace logo. Workspace admin only (the same bar as
 * updateWorkspaceBranding, which saves the returned URL): the caller names the
 * workspace with `orgSlug` + `workspaceSlug` form fields. Raster images only,
 * decided from the file's bytes; the stored key and content type are
 * server-generated.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const orgSlug = form.get("orgSlug");
  const workspaceSlug = form.get("workspaceSlug");
  if (typeof orgSlug !== "string" || typeof workspaceSlug !== "string" || !orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Workspace required" }, { status: 400 });
  }

  try {
    await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    const status = error.message === "Unauthorized" ? 401 : error.message === "Workspace not found" ? 404 : 403;
    return NextResponse.json({ error: error.message }, { status });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  if (file.size > BRANDING_LOGO_MAX_BYTES) {
    return NextResponse.json({ error: "Max 10MB" }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffBrandingLogoType(bytes);
  if (!type) {
    return NextResponse.json({ error: "PNG, JPEG, WebP or GIF images only" }, { status: 400 });
  }

  const stored = await getPublicFileStore().put(
    brandingLogoPathname(type),
    new Blob([bytes], { type: type.contentType }),
    { contentType: type.contentType },
  );
  return NextResponse.json({ url: stored.url });
}
