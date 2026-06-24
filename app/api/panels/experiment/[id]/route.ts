import { NextResponse } from "next/server";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const prisma = getPrisma();

  const experiment = await prisma.experiment.findUnique({
    where: { id },
    include: {
      assumption: { select: { id: true, title: true, riskLevel: true } },
      results: { orderBy: { createdAt: "asc" }, select: { id: true, note: true, createdAt: true } },
    },
  });

  if (!experiment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(experiment);
}
