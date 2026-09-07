import { HeroSection } from "@/components/marketing/hero-section";
import { OstFlowSection } from "@/components/marketing/ost-flow-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { AgentSection } from "@/components/marketing/agent-section";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { getMarketingViewer } from "@/lib/marketing-viewer";

// The page stays public while sharing the request-memoized viewer state with
// the marketing layout, so authenticated CTAs do not trigger a second query.
export default async function MarketingPage() {
  const viewer = await getMarketingViewer();
  return (
    <>
      <HeroSection viewer={viewer} />
      <OstFlowSection />
      <FeaturesSection />
      <AgentSection />
      <MarketingFooter viewer={viewer} />
    </>
  );
}
