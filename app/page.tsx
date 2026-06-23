import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function HomePage() {
  const session = await auth();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="flex flex-col items-center justify-center flex-1 px-4 py-24 gap-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-lg">
        <h1 className="text-4xl font-semibold tracking-tight">
          Welcome to Compass
        </h1>
        <p className="text-lg text-neutral-500">
          Connect customer opportunities to OKRs, run experiments, and ship
          features with confidence.
        </p>
      </div>
      <Link
        href="/login"
        className="rounded-md bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 transition-colors"
      >
        Get Started
      </Link>
    </main>
  );
}
