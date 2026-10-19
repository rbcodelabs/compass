import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ default: () => ({}) }));

import { COMMENT_TARGET_TYPES } from "@/lib/comments";
import { ENTITY_TYPES } from "@/lib/entity-detail";
import { FOLLOWABLE_SUBJECT_TYPES } from "@/lib/followable";
import {
  ENTITY_TYPE_VOCABULARY,
  isLinkableEntityType,
  normalizeEntityType,
  toPanelEntityType,
  toUrlEntityType,
  toWorkspaceEntityType,
} from "@/lib/entity-types";

describe("the entity-type vocabulary", () => {
  it("is exactly COMMENT_TARGET_TYPES plus METRIC and RESEARCH_TURN (written out to avoid an import cycle, pinned here)", () => {
    expect([...ENTITY_TYPE_VOCABULARY]).toEqual([...COMMENT_TARGET_TYPES, "METRIC", "RESEARCH_TURN"]);
  });

  it("contains every followable subject type, so follows and links share one vocabulary", () => {
    expect(FOLLOWABLE_SUBJECT_TYPES.filter((type) => !isLinkableEntityType(type))).toEqual([]);
  });

  it("maps the DECISION alias used by task links to REVIEW_REQUEST and rejects unknown values", () => {
    expect(normalizeEntityType("DECISION")).toBe("REVIEW_REQUEST");
    expect(normalizeEntityType("REVIEW_REQUEST")).toBe("REVIEW_REQUEST");
    expect(normalizeEntityType("EXPERIMENT")).toBe("EXPERIMENT");
    expect(normalizeEntityType("experiment")).toBeNull();
    expect(normalizeEntityType("NOPE")).toBeNull();
    expect(isLinkableEntityType("DECISION")).toBe(false);
  });

  it("adapts to the camelCase panel EntityType and covers every panel type", () => {
    const mapped = ENTITY_TYPE_VOCABULARY.map(toPanelEntityType).filter((type): type is NonNullable<typeof type> => type !== null);
    expect([...mapped].sort()).toEqual([...ENTITY_TYPES].sort());
    expect(toPanelEntityType("FEEDBACK_ITEM")).toBe("feedback");
    expect(toPanelEntityType("KEY_RESULT")).toBe("keyResult");
    expect(toPanelEntityType("DOC")).toBeNull();
  });

  it("adapts to the URL entity type (panel types plus doc and artifact)", () => {
    expect(toUrlEntityType("DOC")).toBe("doc");
    expect(toUrlEntityType("ARTIFACT")).toBe("artifact");
    expect(toUrlEntityType("ROADMAP_ITEM")).toBe("roadmapItem");
    expect(toUrlEntityType("RESEARCH_STUDY")).toBeNull();
  });

  it("adapts to the access-control entity type; METRIC and RESEARCH_TURN have none", () => {
    expect(toWorkspaceEntityType("EXPERIMENT")).toBe("experiment");
    expect(toWorkspaceEntityType("RESEARCH_STUDY")).toBe("researchStudy");
    expect(toWorkspaceEntityType("REVIEW_REQUEST")).toBe("reviewRequest");
    expect(toWorkspaceEntityType("METRIC")).toBeNull();
    expect(toWorkspaceEntityType("RESEARCH_TURN")).toBeNull();
  });
});
