export type QualityArtifactStatus =
  | 'DRAFT' | 'REVIEW_PENDING' | 'REVIEWING' | 'REPAIR_REQUIRED' | 'REPAIRING'
  | 'FINAL_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHHELD' | 'ESCALATED'
  | 'RELEASE_QUEUED' | 'RELEASED' | 'OUTCOME_PENDING' | 'MEASURED';

export type QualityVerdict = 'passed' | 'failed' | 'needs_repair' | 'unavailable';

export const qualityReviewerKinds = [
  'final_gate', 'evidence_claim', 'brand_voice', 'customer_reality',
  'evaluation_calibration', 'visual_ux', 'statistics', 'native_market',
  'claims_compliance', 'repair_orchestrator', 'human',
] as const;

export type QualityReviewerKind = typeof qualityReviewerKinds[number];
