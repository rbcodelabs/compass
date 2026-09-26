import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWorkspaceScoringConfig = { findUnique: vi.fn() };

vi.mock("@/lib/db", () => ({
  default: () => ({ workspaceScoringConfig: mockWorkspaceScoringConfig }),
}));

import {
  isScoreStale,
  resolveWorkspaceScoringModel,
  toOpportunityScoreData,
  toScoreSummary,
} from "@/lib/scoring-model";
import type { ScoringModelData } from "@/lib/types";

const MODEL: ScoringModelData = {
  id: "model-1",
  name: "RICE",
  description: "Classic RICE",
  status: "ACTIVE",
  formulaType: "WEIGHTED_SUM",
  version: 3,
  metrics: [],
};

beforeEach(() => vi.clearAllMocks());

describe("isScoreStale", () => {
  it("is stale when scored under an older model version", () => {
    expect(isScoreStale(1, 3)).toBe(true);
  });

  it("is fresh when scored under the live version", () => {
    expect(isScoreStale(3, 3)).toBe(false);
  });

  it("is fresh when somehow ahead of the live version", () => {
    expect(isScoreStale(4, 3)).toBe(false);
  });
});

describe("resolveWorkspaceScoringModel", () => {
  it("returns null when the workspace has no scoring config", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce(null);
    expect(await resolveWorkspaceScoringModel("ws-1", "OPPORTUNITY")).toBeNull();
  });

  it("returns null when the config exists but no model is attached", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce({ opportunityScoringModel: null, solutionScoringModel: null });
    expect(await resolveWorkspaceScoringModel("ws-1", "OPPORTUNITY")).toBeNull();
  });

  it("maps the Opportunity model and its ordered metrics", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce({
      opportunityScoringModel: {
        id: "model-1",
        name: "RICE",
        description: "Classic RICE",
        status: "ACTIVE",
        formulaType: "WEIGHTED_SUM",
        version: 2,
        metrics: [
          {
            id: "m1",
            key: "reach",
            label: "Reach",
            description: null,
            minValue: 0,
            maxValue: 10,
            weight: 1,
            direction: "POSITIVE",
            order: 0,
            // Columns the projection must drop rather than leak to the client.
            scoringModelId: "model-1",
          },
        ],
      },
      solutionScoringModel: null,
    });

    const model = await resolveWorkspaceScoringModel("ws-1", "OPPORTUNITY");

    expect(mockWorkspaceScoringConfig.findUnique).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      include: {
        opportunityScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } },
        solutionScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } },
      },
    });
    expect(model).toEqual({
      id: "model-1",
      name: "RICE",
      description: "Classic RICE",
      status: "ACTIVE",
      formulaType: "WEIGHTED_SUM",
      version: 2,
      metrics: [
        {
          id: "m1",
          key: "reach",
          label: "Reach",
          description: null,
          minValue: 0,
          maxValue: 10,
          weight: 1,
          direction: "POSITIVE",
          order: 0,
        },
      ],
    });
  });

  it("reads the independent Solution slot when entityType is SOLUTION", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce({
      opportunityScoringModel: { id: "opp-model", name: "Opportunity RICE", description: null, status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1, metrics: [] },
      solutionScoringModel: { id: "sol-model", name: "Solution ICE", description: null, status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1, metrics: [] },
    });

    const model = await resolveWorkspaceScoringModel("ws-1", "SOLUTION");
    expect(model?.id).toBe("sol-model");
  });

  it("returns null for SOLUTION when only the Opportunity slot is set", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce({
      opportunityScoringModel: { id: "opp-model", name: "Opportunity RICE", description: null, status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1, metrics: [] },
      solutionScoringModel: null,
    });

    expect(await resolveWorkspaceScoringModel("ws-1", "SOLUTION")).toBeNull();
  });
});

describe("toScoreSummary", () => {
  it("returns null when there is no score row", () => {
    expect(toScoreSummary(null, MODEL)).toBeNull();
  });

  it("returns null when there is no active model, even with a score row", () => {
    expect(toScoreSummary({ normalizedScore: 50, modelVersion: 1 }, null)).toBeNull();
  });

  it("carries the raw float through and marks a stale score", () => {
    expect(toScoreSummary({ normalizedScore: 11.971830985915492, modelVersion: 1 }, MODEL)).toEqual({
      normalizedScore: 11.971830985915492,
      modelVersion: 1,
      liveModelVersion: 3,
      stale: true,
    });
  });

  it("marks a current-version score as fresh", () => {
    expect(toScoreSummary({ normalizedScore: 72, modelVersion: 3 }, MODEL)?.stale).toBe(false);
  });
});

describe("toOpportunityScoreData", () => {
  const row = {
    id: "score-1",
    scoringModelId: "model-1",
    modelVersion: 1,
    formulaSnapshot: [{ key: "reach" }],
    rawValues: { reach: 5 },
    rawScore: 6,
    normalizedScore: 60,
    scoredAt: new Date("2026-01-02T03:04:05.000Z"),
  };

  it("returns null without a model", () => {
    expect(toOpportunityScoreData(row, null)).toBeNull();
  });

  it("returns null without a row", () => {
    expect(toOpportunityScoreData(null, MODEL)).toBeNull();
  });

  it("expands the row, naming the model and deriving staleness", () => {
    expect(toOpportunityScoreData(row, MODEL)).toEqual({
      id: "score-1",
      scoringModelId: "model-1",
      scoringModelName: "RICE",
      modelVersion: 1,
      formulaType: "WEIGHTED_SUM",
      formulaSnapshot: [{ key: "reach" }],
      rawValues: { reach: 5 },
      rawScore: 6,
      normalizedScore: 60,
      scoredAt: "2026-01-02T03:04:05.000Z",
      stale: true,
    });
  });
});
