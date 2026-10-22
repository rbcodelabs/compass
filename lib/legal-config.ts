/**
 * Shared facts for the public legal pages. Kept in one place so a change of
 * contact address, entity name or governing law is a one-line edit.
 */
export const LEGAL_OPERATOR = "RB Code Labs LLC";
export const LEGAL_PRODUCT = "Compass";
export const LEGAL_LAST_UPDATED = "October 21, 2026";

export const LEGAL_CONTACT_EMAIL = "privacy@rbcodelabs.com";

export const LEGAL_GOVERNING_LAW_STATE = "Michigan";

/**
 * How long agent conversation messages and agent run events are kept. The
 * retention job (lib/agent-retention.ts) and the Privacy Policy both read this,
 * so the published promise and the enforced one cannot drift apart.
 */
export const AGENT_DATA_RETENTION_DAYS = 365;
/** The human-readable form of AGENT_DATA_RETENTION_DAYS used in the policy text (a unit test keeps the two in step). */
export const AGENT_DATA_RETENTION_LABEL = "one year";

export const GOOGLE_LIMITED_USE_STATEMENT =
  "Compass's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";
