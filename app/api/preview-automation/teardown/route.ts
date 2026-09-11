import { handlePreviewAutomation } from "@/lib/preview-automation/handler";
export const runtime = "nodejs";
export async function POST(request: Request) { return handlePreviewAutomation(request, "teardown"); }
