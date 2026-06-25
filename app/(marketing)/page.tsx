import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { HeroSection } from "@/components/marketing/hero-section";
import { OstFlowSection } from "@/components/marketing/ost-flow-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { AgentSection } from "@/components/marketing/agent-section";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

export default async function MarketingPage() {
  const session = await auth();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <>
      <HeroSection />
      <OstFlowSection />
      <FeaturesSection />
      <AgentSection />
      <MarketingFooter />
    </>
  );
}
