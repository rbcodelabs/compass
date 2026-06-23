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
export type Horizon = "NOW" | "NEXT" | "LATER"
export type ItemStatus = "ACTIVE" | "ARCHIVED"
