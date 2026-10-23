/**
 * Summaries and the shared-section view for EXPERIMENT_INFORMED_BY_STUDY, over the tenant fake:
 * workspace scoping, PM_INTERVIEW and EXTERNAL exclusion, archived-study rules and the feature flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModules } from "../helpers/modules"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import type { AppTransactionClient } from "@/lib/db";
import { getLinkedEntitiesView, loadLinkSummaries } from "@/lib/links/read-models";

const KEY = "EXPERIMENT_INFORMED_BY_STUDY";
let fake: ReturnType<typeof createTenantFakePrisma>;
const tx = () => fake.client as unknown as AppTransactionClient;
let n = 0;
const link = (fromId: string, toId: string, workspaceId: string = WS_A.id) =>
  fake.state.entityLinks.push({ id: `l${++n}`, workspaceId, linkType: KEY, fromType: "EXPERIMENT", fromId, toType: "RESEARCH_STUDY", toId, createdAt: new Date(n), updatedAt: new Date(n) });
const view = (entityType: string, entityId: string, query = "") => getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType, entityId, linkType: KEY, query });

beforeEach(() => { fake = createTenantFakePrisma(); n = 0; vi.stubEnv("NODE_ENV", "test"); });
afterEach(() => vi.unstubAllEnvs());

describe("loadLinkSummaries", () => {
  it("adds linkedStudies to an experiment and linkedExperiments to a study, selecting only the spec fields", async () => {
    link("exp-a", "study-a");
    link("exp-a", "study-a-archived");
    link("exp-a2", "study-a");
    expect(await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a" })).toEqual({
      linkedStudies: [
        { id: "study-a-archived", name: "A archived", studyType: "CUSTOMER_INTERVIEW", status: "ARCHIVED" },
        { id: "study-a", name: "A interviews", studyType: "CUSTOMER_INTERVIEW", status: "ACTIVE" },
      ],
    });
    const reciprocal = await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "RESEARCH_STUDY", entityId: "study-a" });
    expect(reciprocal.linkedExperiments.map((row) => row.id)).toEqual(["exp-a", "exp-a2"]);
    expect(Object.keys(reciprocal.linkedExperiments[0]).sort()).toEqual(["id", "status", "title"]);
  });

  it("never returns a PM interview study or another workspace's rows, even if a link row exists", async () => {
    link("exp-a", "study-a-pm");
    link("exp-a", "study-b");
    link("exp-b", "study-b", WS_B.id);
    expect((await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a" })).linkedStudies).toEqual([]);
  });

  it("is empty for an entity type with no link types and omitted when the research flag is off", async () => {
    expect(await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "TASK", entityId: "t" })).toEqual({});
    link("exp-a", "study-a");
    vi.stubEnv("NODE_ENV", "production");
    setModules({ research_capture: false });
    expect(await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a" })).toEqual({});
  });
});

describe("getLinkedEntitiesView", () => {
  it("from the experiment: registry label, linked studies (archived kept) and only eligible, unlinked candidates", async () => {
    link("exp-a", "study-a-archived");
    const v = await view("EXPERIMENT", "exp-a");
    expect(v).toMatchObject({ label: "Informed by", side: "from", otherNoun: "research study", canLink: true });
    expect(v!.linked.map((i) => i.id)).toEqual(["study-a-archived"]);
    expect(v!.candidates.map((i) => i.id).sort()).toEqual(["study-a", "study-a-usability"]);
  });

  it("searches candidates by name", async () => {
    expect((await view("EXPERIMENT", "exp-a", "usab"))!.candidates.map((i) => i.id)).toEqual(["study-a-usability"]);
  });

  it("from the study: 'Informs', experiments of this workspace only", async () => {
    const v = await view("RESEARCH_STUDY", "study-a");
    expect(v).toMatchObject({ label: "Informs", side: "to", otherNoun: "experiment", canLink: true });
    expect(v!.candidates.map((i) => i.id).sort()).toEqual(["exp-a", "exp-a2"]);
  });

  it("an archived study shows its links but offers no new one", async () => {
    link("exp-a", "study-a-archived");
    const v = await view("RESEARCH_STUDY", "study-a-archived");
    expect(v!.linked.map((i) => i.id)).toEqual(["exp-a"]);
    expect(v).toMatchObject({ canLink: false, candidates: [] });
  });

  it("is null for PM interview and external studies, a foreign entity, and a disabled flag", async () => {
    expect(await view("RESEARCH_STUDY", "study-a-pm")).toBeNull();
    expect(await view("RESEARCH_STUDY", "study-a-external")).toBeNull();
    expect(await view("EXPERIMENT", "exp-b")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    setModules({ research_capture: false });
    expect(await view("EXPERIMENT", "exp-a")).toBeNull();
  });
});
