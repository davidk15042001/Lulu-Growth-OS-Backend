type Review = { reviewerAgentId?: string; reviewerKind?: string; verdict?: string };
type Finding = { severity?: string; resolvedAt?: string | null };

export function releaseBlockers(input: {
  reviews: Review[];
  findings: Finding[];
  providerStatus: string;
  riskClass: string;
  independentReviewRequired: boolean;
}) {
  const blockers: string[] = [];
  if (input.providerStatus !== 'completed') blockers.push('provider_result_not_completed');
  if (input.findings.some((finding) => finding.severity === 'hard_block' && !finding.resolvedAt)) blockers.push('open_hard_block');
  if (!input.reviews.some((review) => review.reviewerKind === 'final_gate' && review.verdict === 'passed')) blockers.push('final_gate_not_passed');
  if (input.riskClass === 'regulated' || input.independentReviewRequired) {
    const independent = new Set(input.reviews.filter((review) => review.verdict === 'passed' && review.reviewerKind !== 'final_gate').map((review) => review.reviewerAgentId).filter(Boolean));
    if (independent.size < 2) blockers.push('independent_review_required');
  }
  return blockers;
}
