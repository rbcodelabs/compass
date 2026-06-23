import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  return (
    <main className="flex flex-col flex-1 p-8 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-neutral-500">
        Welcome, {session.user?.name ?? session.user?.email}. Select a workspace
        to get started.
      </p>
    </main>
  );
}
