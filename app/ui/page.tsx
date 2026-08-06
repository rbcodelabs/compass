import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { UIRegistry } from "@/components/ui-registry";

export const metadata: Metadata = {
  title: "UI Registry",
  robots: { index: false, follow: false },
};

function registryEnabled() {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.COMPASS_UI_REGISTRY === "1"
  );
}

export default function UIRegistryPage() {
  if (!registryEnabled()) notFound();

  return <UIRegistry />;
}
