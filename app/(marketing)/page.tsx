import { HeroSection } from "@/components/marketing/hero-section";
import { OstFlowSection } from "@/components/marketing/ost-flow-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { AgentSection } from "@/components/marketing/agent-section";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

// Marketing page — always public, no DB call needed.
// Logged-in users see this too; the "Sign in" link and app nav handle them.
// On Vercel the middleware redirects protected routes, so this is fine.
export default function MarketingPage() {
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
