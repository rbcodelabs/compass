import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_GOVERNING_LAW_STATE,
  LEGAL_OPERATOR,
  LEGAL_PRODUCT,
} from "@/lib/legal-config";
import { getMarketingViewer } from "@/lib/marketing-viewer";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of Compass, operated by RB Code Labs.",
  robots: { index: true, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "agreement",
    heading: "Agreement",
    body: (
      <p>
        These terms govern your use of {LEGAL_PRODUCT}, operated by {LEGAL_OPERATOR}. By creating an account or using
        the service you agree to them. If you use Compass on behalf of an organization, you confirm you may bind it.
      </p>
    ),
  },
  {
    id: "accounts",
    heading: "Accounts",
    body: (
      <ul>
        <li>You must provide accurate information and keep your sign-in methods secure.</li>
        <li>You are responsible for activity under your account and for managing who has access to your workspaces.</li>
        <li>Tell us promptly if you believe your account has been compromised.</li>
      </ul>
    ),
  },
  {
    id: "acceptable-use",
    heading: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>break the law or infringe the rights of others;</li>
          <li>upload malware or attempt to disrupt, probe or gain unauthorized access to the service or other accounts;</li>
          <li>circumvent rate limits, access controls or security measures;</li>
          <li>use the service or its agent to generate content that is unlawful, harassing or deceptive;</li>
          <li>resell or provide the service to third parties except as we permit.</li>
        </ul>
      </>
    ),
  },
  {
    id: "your-content",
    heading: "Your content",
    body: (
      <p>
        You own the content you put into Compass. You grant {LEGAL_OPERATOR} a limited license to host, process and
        display it solely to operate and provide the service to you and the people you share it with. You are
        responsible for having the rights to the content you submit.
      </p>
    ),
  },
  {
    id: "ai-and-third-party-services",
    heading: "AI features and third-party services",
    body: (
      <>
        <p>
          Compass includes an AI agent and can connect to third-party services such as Google Drive. Agent output can be
          inaccurate or incomplete, and you should review it before relying on it, especially before approving changes
          to your files or data. When the agent acts through a connector with write access, it acts with your
          permissions.
        </p>
        <p>
          Third-party services are governed by their own terms and privacy policies, and we are not responsible for
          them. Our handling of data is described in the <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </>
    ),
  },
  {
    id: "disclaimer",
    heading: "Disclaimer",
    body: (
      <p>
        Compass is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind, express or
        implied, including merchantability, fitness for a particular purpose and non-infringement. We do not warrant
        that the service will be uninterrupted or error-free.
      </p>
    ),
  },
  {
    id: "limitation-of-liability",
    heading: "Limitation of liability",
    body: (
      <p>
        To the maximum extent permitted by law, {LEGAL_OPERATOR} will not be liable for indirect, incidental, special,
        consequential or punitive damages, or for lost profits, data or goodwill. Our total liability for any claim
        relating to the service is limited to the greater of the amount you paid us in the twelve months before the
        claim and one hundred US dollars.
      </p>
    ),
  },
  {
    id: "termination",
    heading: "Termination",
    body: (
      <p>
        You may stop using Compass at any time. We may suspend or terminate access if you breach these terms or if
        needed to protect the service or other users. Sections that by their nature should survive termination will
        survive.
      </p>
    ),
  },
  {
    id: "changes",
    heading: "Changes to these terms",
    body: (
      <p>
        We may update these terms. The &quot;Last updated&quot; date shows the latest revision. Continued use after a
        change means you accept the updated terms.
      </p>
    ),
  },
  {
    id: "governing-law",
    heading: "Governing law",
    body: (
      <p>
        These terms are governed by the laws of the State of {LEGAL_GOVERNING_LAW_STATE}, without regard to conflict of
        law rules.
      </p>
    ),
  },
  {
    id: "contact",
    heading: "Contact",
    body: (
      <p>
        Questions about these terms: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
      </p>
    ),
  },
];

export default async function TermsPage() {
  const viewer = await getMarketingViewer();
  return (
    <>
      <LegalPage title="Terms of Service" sections={sections} />
      <MarketingFooter viewer={viewer} />
    </>
  );
}
