import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import {
  GOOGLE_LIMITED_USE_STATEMENT,
  LEGAL_CONTACT_EMAIL,
  LEGAL_OPERATOR,
  LEGAL_PRODUCT,
} from "@/lib/legal-config";
import { getMarketingViewer } from "@/lib/marketing-viewer";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Compass, operated by RB Code Labs, collects, uses, shares and protects your data, including Google user data.",
  robots: { index: true, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "who-we-are",
    heading: "Who we are",
    body: (
      <p>
        {LEGAL_PRODUCT} is a product management workspace operated by {LEGAL_OPERATOR} (&quot;we&quot;,
        &quot;us&quot;). This policy explains what information {LEGAL_PRODUCT} collects, how it is used and who it is
        shared with. Questions can be sent to{" "}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
      </p>
    ),
  },
  {
    id: "information-we-collect",
    heading: "Information we collect",
    body: (
      <ul>
        <li>
          <strong>Account information.</strong> Your name and email address, supplied when you sign in with Google or
          by email link, and details of any passkey you register. When you sign in with Google, Compass receives your
          basic Google profile (name, email address and profile identifier) and stores the sign-in tokens Google
          issues for that sign-in alongside your account record.
        </li>
        <li>
          <strong>Workspace content.</strong> The objectives, opportunities, solutions, documents, comments, tasks,
          research material and other content you or your teammates create in Compass, and files you upload.
        </li>
        <li>
          <strong>Agent conversations.</strong> Messages you send to the Compass agent and the responses it produces,
          including content it reads from workspace data or from connectors you have enabled.
        </li>
        <li>
          <strong>Feedback and portal submissions.</strong> Comments and feedback entered through a public feedback
          portal or the embedded feedback widget, including any account details you provide to post them.
        </li>
        <li>
          <strong>Usage and technical data.</strong> Standard request data such as IP address, browser type and pages
          visited, and aggregate product analytics collected through our hosting provider.
        </li>
      </ul>
    ),
  },
  {
    id: "how-we-use-information",
    heading: "How we use information",
    body: (
      <ul>
        <li>To provide, secure and maintain Compass, including authentication and workspace access control.</li>
        <li>To run the Compass agent and any connectors you choose to enable.</li>
        <li>To send sign-in emails and other messages needed to operate your account.</li>
        <li>To diagnose problems, prevent abuse and improve reliability.</li>
      </ul>
    ),
  },
  {
    id: "google-user-data",
    heading: "Google user data",
    body: (
      <>
        <p>
          Compass interacts with Google in two ways, and this section describes how we handle the information we
          receive from Google APIs.
        </p>
        <h3 className="text-base font-semibold text-text-primary">Google sign-in</h3>
        <p>
          If you choose to sign in with Google, we receive your name, email address and Google account identifier. We
          use them only to create and identify your Compass account.
        </p>
        <h3 className="text-base font-semibold text-text-primary">Google Drive connector (optional)</h3>
        <p>
          If you choose to enable the Google Drive connector in Settings, you pick one of two access levels, and we
          request only the corresponding scope:
        </p>
        <ul>
          <li>
            <code>https://www.googleapis.com/auth/drive.readonly</code> (&quot;Read only&quot;): lets the Compass
            agent search for and read files in your Google Drive. Nothing can be created, changed, deleted or shared.
          </li>
          <li>
            <code>https://www.googleapis.com/auth/drive</code> (&quot;Read and write&quot;): additionally lets the
            agent create, edit, move, trash and share files on your behalf. The agent is instructed to make such
            changes only when you ask for that specific change.
          </li>
        </ul>
        <p>
          We need this access for one purpose: so the Compass agent can find, read and, if you chose write access,
          change Drive files at your request. Drive content the agent reads is sent to our AI model provider as part of
          the conversation in order to produce a response, and is not otherwise copied into your workspace unless you
          ask the agent to do so.
        </p>
        <p>
          Content the agent reads from Drive can be stored in Compass. The agent&apos;s replies are saved as
          conversation messages and may quote or summarize Drive files, and the detailed event record of each agent run
          (which includes the results of tools the agent called, such as Drive file contents) is stored in the Compass
          database. We do not currently apply an automatic retention period to conversation messages or run records:
          they are kept until the workspace they belong to is deleted, which permanently deletes that
          workspace&apos;s agent conversations, messages and run records. Disconnecting Google Drive does not delete
          them. To have this content removed without deleting the workspace, or to have your account deleted, email{" "}
          <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </p>
        <h3 className="text-base font-semibold text-text-primary">How we protect and limit Google data</h3>
        <ul>
          <li>
            Access and refresh tokens for the Drive connector are stored encrypted in the Compass database and are used
            only to call Google Drive on your behalf.
          </li>
          <li>
            Separately, the tokens Google issues when you sign in with Google are stored in the Compass database as
            part of your account record and are not encrypted at the application level. They are unaffected by
            disconnecting the Drive connector and are removed only when your account is deleted.
          </li>
          <li>We do not sell Google user data.</li>
          <li>We do not use Google user data for advertising, including personalized or retargeted advertising.</li>
          <li>
            We do not use Google user data to develop, improve or train generalized artificial intelligence or machine
            learning models.
          </li>
          <li>
            We share Google user data only as needed to provide the feature you enabled (for example, with our AI model
            provider while the agent processes your request), to comply with applicable law, or as part of a merger or
            sale with notice to you. Our staff do not routinely read your Google data, and we access it only as
            needed to provide support you request, to investigate security or abuse, or to comply with law.
          </li>
        </ul>
        <h3 className="text-base font-semibold text-text-primary">Revoking access and deletion</h3>
        <p>
          You can disconnect Google Drive at any time in Compass under Settings, Agents. Disconnecting removes our
          stored copy of the tokens and asks Google to revoke them (revocation is best effort). You can also remove Compass&apos;s access directly
          at{" "}
          <a href="https://myaccount.google.com/permissions" rel="noopener noreferrer">
            https://myaccount.google.com/permissions
          </a>
          . To have your account and its data deleted, email{" "}
          <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </p>
        <p className="font-medium text-text-primary">{GOOGLE_LIMITED_USE_STATEMENT}</p>
      </>
    ),
  },
  {
    id: "service-providers",
    heading: "Service providers",
    body: (
      <>
        <p>
          We use the following providers to operate Compass. Each receives the data needed for the function it performs.
        </p>
        <ul>
          <li>
            <strong>Vercel</strong>: application hosting, sandboxed execution of the Compass agent, file storage,
            product analytics and an AI gateway.
          </li>
          <li>
            <strong>Amazon Web Services</strong>: the Aurora DSQL database that stores account and workspace data, and
            optionally Amazon Bedrock as an AI model provider.
          </li>
          <li>
            <strong>Anthropic</strong>: the AI models that power the Compass agent (directly, or through Amazon Bedrock
            or the Vercel AI gateway).
          </li>
          <li>
            <strong>Resend</strong>: delivery of sign-in emails.
          </li>
          <li>
            <strong>OpenAI</strong>: realtime voice sessions, used only if a voice research session is run.
          </li>
          <li>
            <strong>Perplexity</strong>: web search requests made by the agent, routed through the Vercel AI gateway.
            Search queries written by the agent are sent to the provider, and a query could include information from your conversation.
          </li>
          <li>
            <strong>Connectors you enable</strong>, such as Google Drive or v0, which exchange data with Compass at your
            direction.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "retention",
    heading: "Retention and deletion",
    body: (
      <p>
        We keep account and workspace data for as long as your account is active, and workspace content for as long as
        your workspace exists. Connector tokens are removed when you disconnect the connector. You can ask us to delete
        your account and associated personal data by emailing{" "}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>. We may retain limited information where
        required by law or to resolve disputes, and backups are overwritten on the provider&apos;s normal schedule.
      </p>
    ),
  },
  {
    id: "security",
    heading: "Security",
    body: (
      <p>
        We use access controls, encrypted connections and encryption of stored connector credentials to protect your
        data. No system is perfectly secure, so we cannot guarantee absolute security.
      </p>
    ),
  },
  {
    id: "your-choices",
    heading: "Your choices and rights",
    body: (
      <p>
        You may access, correct or delete your information by using Compass or by contacting us. Depending on where you
        live, you may have additional rights under local law; contact us and we will respond as required.
      </p>
    ),
  },
  {
    id: "children",
    heading: "Children",
    body: <p>Compass is not directed to children under 13 and we do not knowingly collect their information.</p>,
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    body: (
      <p>
        We may update this policy from time to time. The &quot;Last updated&quot; date above shows the latest revision,
        and material changes will be communicated through Compass or by email.
      </p>
    ),
  },
  {
    id: "contact",
    heading: "Contact",
    body: (
      <p>
        {LEGAL_OPERATOR}, <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>. See also our{" "}
        <Link href="/terms">Terms of Service</Link>.
      </p>
    ),
  },
];

export default async function PrivacyPage() {
  const viewer = await getMarketingViewer();
  return (
    <>
      <LegalPage title="Privacy Policy" sections={sections} />
      <MarketingFooter viewer={viewer} />
    </>
  );
}
