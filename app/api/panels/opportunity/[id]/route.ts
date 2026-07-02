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

  const opportunity = await prisma.opportunity.findUnique({
    where: { id },
    include: {
      linkedKeyResult: {
        select: {
          id: true,
          title: true,
          current: true,
          target: true,
          unit: true,
          objective: { select: { title: true, cycleId: true } },
        },
      },
      solutions: {
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "asc" },
      },
      evidence: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!opportunity) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(opportunity);
}
