import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { passkeysEnabled } from "@/lib/passkeys";
import { AccountPasskeysPanel } from "@/components/settings/account-passkeys-panel";
import { PageHeader } from "@/components/patterns/page-header";

export const metadata = { title: "Passkeys" };

export default async function PasskeysPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const prisma = getPrisma();
  const authenticators = await prisma.authenticator.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, credentialDeviceType: true, credentialBackedUp: true, createdAt: true },
  });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Link href="/dashboard" className="text-sm text-text-subtle underline">
        Back to Compass
      </Link>
      <PageHeader
        title="Passkeys"
        description="Sign in without a password using a passkey stored on this device or synced across your devices."
      />
      <AccountPasskeysPanel
        enabled={passkeysEnabled()}
        authenticators={authenticators.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
      />
    </main>
  );
}
