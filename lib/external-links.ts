// External links (ADR-0028): recognise a pasted URL that points OUTSIDE Compass (GitHub, Jira, Figma, Google, Slack, anything
// else) so a Solution or Task can keep it as a durable, queryable link. Client-safe: no server imports, never throws.
//
// WHY A STRICT PARSER - the stored URL is rebuilt from the matched parts, never the raw string, and only https is accepted, so
// javascript:, data:, credentials in the URL, ports and look-alike hosts (github.com.evil.example) cannot become a link
// that renders as something it is not. Nothing here fetches anything: an unrecognised host is stored as an inert OTHER link.
//
// WHY EXTERNAL KEYS - externalKey is the identity the provider itself uses (owner/repo#482, site/PROJ-456), lower-cased where the
// provider is case-insensitive, so the same PR pasted twice in different spellings is one link (unique per subject+provider+key).
import { parseGoogleDriveLink } from "@/lib/google-drive-links"
import { parsePullRequestUrl, pullRequestUrl } from "@/lib/github-pull-request-links"

export const EXTERNAL_LINK_PROVIDERS = ["GITHUB_PR", "GITHUB_ISSUE", "JIRA_ISSUE", "FIGMA", "GOOGLE_DRIVE", "SLACK_THREAD", "OTHER"] as const
export type ExternalLinkProvider = (typeof EXTERNAL_LINK_PROVIDERS)[number]

export const EXTERNAL_LINK_RELATIONS = ["IMPLEMENTS", "TRACKS", "DESIGN", "DOCS", "DISCUSSION", "RELATED"] as const
export type ExternalLinkRelation = (typeof EXTERNAL_LINK_RELATIONS)[number]

// Objects that can carry external links. The table shape allows more later; this is the enforced set.
export const EXTERNAL_LINK_SUBJECT_TYPES = ["SOLUTION", "TASK"] as const
export type ExternalLinkSubjectType = (typeof EXTERNAL_LINK_SUBJECT_TYPES)[number]

// Longest URL (and external key) we store. Keeps the unique index well inside a btree entry.
export const EXTERNAL_LINK_MAX_URL_LENGTH = 1000
export const EXTERNAL_LINK_MAX_TITLE_LENGTH = 255

export interface ParsedExternalLink {
  provider: ExternalLinkProvider
  // Canonical https URL rebuilt from the matched parts.
  url: string
  // The identity the provider uses, and the dedupe key.
  externalKey: string
  // Short human title derived from the URL alone, e.g. acme/web #482.
  title: string
  // Relation to suggest when the user has not picked one.
  defaultRelation: ExternalLinkRelation
}

const PROVIDER_LABELS: Record<ExternalLinkProvider, string> = {
  GITHUB_PR: "GitHub pull request",
  GITHUB_ISSUE: "GitHub issue",
  JIRA_ISSUE: "Jira issue",
  FIGMA: "Figma",
  GOOGLE_DRIVE: "Google Drive",
  SLACK_THREAD: "Slack thread",
  OTHER: "Link",
}

export function providerLabel(provider: ExternalLinkProvider): string {
  return PROVIDER_LABELS[provider]
}

export function isExternalLinkProvider(value: unknown): value is ExternalLinkProvider {
  return typeof value === "string" && (EXTERNAL_LINK_PROVIDERS as readonly string[]).includes(value)
}

export function isExternalLinkRelation(value: unknown): value is ExternalLinkRelation {
  return typeof value === "string" && (EXTERNAL_LINK_RELATIONS as readonly string[]).includes(value)
}

export function isExternalLinkSubjectType(value: unknown): value is ExternalLinkSubjectType {
  return typeof value === "string" && (EXTERNAL_LINK_SUBJECT_TYPES as readonly string[]).includes(value)
}

// Shape checks are a character class plus a length range (no regex quantifiers), so each rule reads the same everywhere.
function fits(pattern: RegExp, value: string | undefined, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && pattern.test(value)
}

const GH_PART = /^[A-Za-z0-9._-]+$/
const DIGITS = /^[0-9]+$/
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/
const ALNUM = /^[A-Za-z0-9]+$/
const UPPER_ALNUM = /^[A-Z0-9]+$/
const SLACK_TS = /^p[0-9]+$/

const DEFAULT_RELATION: Record<ExternalLinkProvider, ExternalLinkRelation> = {
  GITHUB_PR: "IMPLEMENTS",
  GITHUB_ISSUE: "TRACKS",
  JIRA_ISSUE: "TRACKS",
  FIGMA: "DESIGN",
  GOOGLE_DRIVE: "DOCS",
  SLACK_THREAD: "DISCUSSION",
  OTHER: "RELATED",
}

function make(provider: ExternalLinkProvider, url: string, externalKey: string, title: string): ParsedExternalLink | null {
  if (url.length > EXTERNAL_LINK_MAX_URL_LENGTH || externalKey.length > EXTERNAL_LINK_MAX_URL_LENGTH) return null
  return { provider, url, externalKey, title: title.slice(0, EXTERNAL_LINK_MAX_TITLE_LENGTH), defaultRelation: DEFAULT_RELATION[provider] }
}

// Parses a safe https URL: no credentials, no port, a dotted hostname. Null otherwise.
function safeUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null
  return url
}

// The display half of a stored key: site/PROJ-456 shows as PROJ-456, owner/repo#5 as itself.
export function displayKey(provider: ExternalLinkProvider, externalKey: string): string {
  if (provider === "JIRA_ISSUE") return externalKey.split("/").pop() ?? externalKey
  return externalKey
}

// Inputs longer than this are rejected before parsing; the stored URL is capped separately by EXTERNAL_LINK_MAX_URL_LENGTH.
const MAX_INPUT_LENGTH = 4000

// Any other https URL: kept as an inert link. The hash is dropped, the host is lower-cased, and a trailing slash is not significant.
function parseOther(url: URL, host: string): ParsedExternalLink | null {
  let path = url.pathname
  while (path.endsWith("/")) path = path.slice(0, -1)
  const canonical = "https://" + host + path + url.search
  return make("OTHER", canonical, canonical, host.replace(/^www\./, "") + path)
}

// Recognises one pasted URL. Null when it is not a usable external link (not https, unsafe, too long, or not a URL at all).
// Never throws and never touches the network.
export function parseExternalLink(value: string | null | undefined): ParsedExternalLink | null {
  if (!value || value.length > MAX_INPUT_LENGTH) return null
  const url = safeUrl(value)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split("/").filter(Boolean)

  // GitHub. Reuse the existing PR parser so the chip, the panel and this agree on what a PR URL is.
  if (host === "github.com") {
    const pr = parsePullRequestUrl(url.toString())
    if (pr) {
      const name = pr.owner + "/" + pr.repo
      return make("GITHUB_PR", pullRequestUrl(pr), (name + "#" + pr.number).toLowerCase(), name + " #" + pr.number)
    }
    const [owner, repo, kind, num] = parts
    if (kind === "issues" && fits(GH_PART, owner, 1, 100) && fits(GH_PART, repo, 1, 100) && fits(DIGITS, num, 1, 9) && Number(num) !== 0) {
      const name = owner + "/" + repo
      return make("GITHUB_ISSUE", "https://github.com/" + name + "/issues/" + num, (name + "#" + num).toLowerCase(), name + " #" + num)
    }
    return parseOther(url, host)
  }

  // Jira Cloud: https://SITE.atlassian.net/browse/PROJ-456. Phase 1 only labels the link; it never calls Jira.
  if (host.endsWith(".atlassian.net")) {
    const site = host.slice(0, -".atlassian.net".length)
    if (fits(SUBDOMAIN, site, 1, 63) && parts.length === 2 && parts[0] === "browse" && fits(JIRA_KEY, parts[1], 4, 30)) {
      return make("JIRA_ISSUE", "https://" + site + ".atlassian.net/browse/" + parts[1], site + "/" + parts[1], parts[1])
    }
    return parseOther(url, host)
  }

  if (host === "figma.com" || host === "www.figma.com") {
    const [kind, key] = parts
    if (kind && ["file", "design", "board", "proto", "make"].includes(kind) && fits(ALNUM, key, 10, 64)) {
      return make("FIGMA", "https://www.figma.com/" + kind + "/" + key, key, "Figma file")
    }
    return parseOther(url, host)
  }

  if (host === "docs.google.com" || host === "drive.google.com") {
    const drive = parseGoogleDriveLink(url.toString())
    if (drive) return make("GOOGLE_DRIVE", url.toString().split("#")[0], drive.fileId, drive.label)
    return parseOther(url, host)
  }

  if (host.endsWith(".slack.com")) {
    const workspace = host.slice(0, -".slack.com".length)
    const [archives, channel, ts] = parts
    if (fits(SUBDOMAIN, workspace, 1, 63) && archives === "archives" && fits(UPPER_ALNUM, channel, 9, 14) && fits(SLACK_TS, ts, 11, 21)) {
      return make("SLACK_THREAD", "https://" + workspace + ".slack.com/archives/" + channel + "/" + ts, workspace + "/" + channel + "/" + ts, "Slack thread")
    }
    return parseOther(url, host)
  }

  return parseOther(url, host)
}
