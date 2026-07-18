// String union types replacing Prisma enums.
// Aurora DSQL does not support PostgreSQL enum types, so all enum fields
// are stored as VARCHAR(50). These aliases preserve full type safety in
// application code without requiring database-level enum support.

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER"
export type WorkspaceRole = "ADMIN" | "MEMBER"
export type CycleStatus = "DRAFT" | "ACTIVE" | "CLOSED"
export type ObjectiveStatus = "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE"
export type OpportunityStatus = "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED"
export type SolutionStatus = "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED"
export type AssumptionStatus = "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED"
export type RiskLevel = "HIGH" | "MEDIUM" | "LOW"
export type ExperimentStatus = "DESIGNING" | "RUNNING" | "COMPLETE" | "KILLED"
export type Conclusion = "PROCEED" | "KILL" | "ITERATE"
export type Horizon = "NOW" | "NEXT" | "LATER" | "SHIPPED"
export type ItemStatus = "ACTIVE" | "ARCHIVED"
export type FeedbackType = "BUG" | "IDEA"

// Custom Fields
export type CustomFieldObjectType =
  | "OPPORTUNITY"
  | "SOLUTION"
  | "EXPERIMENT"
  | "OBJECTIVE"
  | "KEY_RESULT"
  | "ROADMAP_ITEM"

export type CustomFieldType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "SELECT"
  | "MULTI_SELECT"
  | "URL"
  | "BOOLEAN"

export interface SelectOption {
  label: string
  value: string
  color?: string
}

export interface CustomFieldDefinitionData {
  id: string
  name: string
  fieldType: CustomFieldType
  objectType: CustomFieldObjectType
  options: SelectOption[] | null
  required: boolean
  order: number
}

export type CustomFieldValue =
  | string
  | number
  | boolean
  | string[]
  | null

// Squads
export interface SquadData {
  id: string
  name: string
  color: string
}

// Workspace Members
export interface MemberData {
  id: string
  userId: string
  email: string
  name: string | null
  role: WorkspaceRole
}

// Scoring Models
export type ScoringModelStatus = "ACTIVE" | "ARCHIVED"
export type ScoringFormulaType = "WEIGHTED_SUM" | "MULTIPLICATIVE"
export type MetricDirection = "POSITIVE" | "NEGATIVE"

export interface ScoringMetricData {
  id: string
  key: string
  label: string
  description: string | null
  minValue: number
  maxValue: number
  weight: number
  direction: MetricDirection
  order: number
}

export interface ScoringModelData {
  id: string
  name: string
  description: string | null
  status: ScoringModelStatus
  formulaType: ScoringFormulaType
  version: number
  metrics: ScoringMetricData[]
}

/** A metric definition frozen at scoring time — stored in OpportunityScore.formulaSnapshot. */
export interface FormulaSnapshotMetric {
  key: string
  label: string
  minValue: number
  maxValue: number
  weight: number
  direction: MetricDirection
}

export interface OpportunityScoreData {
  id: string
  scoringModelId: string
  scoringModelName: string
  modelVersion: number
  formulaType: ScoringFormulaType
  formulaSnapshot: FormulaSnapshotMetric[]
  rawValues: Record<string, number>
  rawScore: number
  normalizedScore: number
  scoredAt: string
  /** True when scoringModelId's live ScoringModel.version is ahead of modelVersion. */
  stale: boolean
}
