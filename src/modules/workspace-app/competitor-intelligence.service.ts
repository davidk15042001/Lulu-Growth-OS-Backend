import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import * as recordRepo from '../records/record.repo.js';
import type { WorkspaceRecord } from '../records/record.repo.js';
import * as websiteRepo from '../websites/website.repo.js';
import * as workspaceService from '../workspaces/workspace.service.js';

type CompetitorRow = {
  n: string;
  l: string;
  c: string;
  rank: number;
  type: string;
  market: string;
  pos: string;
  growth: string;
  vis: string;
  pri: string;
  intel: string;
  when: string;
  websiteUrl: string;
  positioning: string;
  strengths: string[];
  weaknesses: string[];
  differentiators: string[];
  featureOverlap: string[];
  sourceQuality: string;
};

type BaselineCategory = {
  key: string;
  label: string;
  yourScore: number;
  competitorScore: number;
  source: string;
  yourEvidence: string;
  competitorEvidence: string;
  why: string;
  nextMove: string;
  gap: number;
  priority: 'High' | 'Medium' | 'Low';
  fastestWin: boolean;
};

type BattleAction = {
  title: string;
  detail: string;
  impact: 'High' | 'Medium' | 'Low';
  speed: 'Fast' | 'Medium' | 'Strategic';
  category: string;
  outcome: string;
};

type SummaryCard = {
  label: string;
  value: string;
  detail: string;
  tone: 'green' | 'amber' | 'red' | 'purple';
  action: string;
};

type KpiCard = {
  title: string;
  value: string;
  sub: string;
  icon: 'Sparkles' | 'AlertTriangle' | 'Activity' | 'Target' | 'Users' | 'TrendingUp';
};

type SnapshotCard = {
  title: string;
  detail: string;
  footnote: string;
};

type DataGap = {
  title: string;
  detail: string;
  resolved: boolean;
};

type EvidenceItem = {
  title: string;
  source: string;
  category: 'Observed' | 'AI Inferred';
  confidence: 'High' | 'Medium' | 'Low';
  updated: string;
  detail: string;
  why: string;
  link: string;
};

type ChangeTrackingItem = {
  title: string;
  when: string;
  impact: 'High' | 'Medium' | 'Low';
  detail: string;
};

type WorkflowAction = {
  label: string;
  detail: string;
  cadence: string;
  output: string;
};

type ComparisonMetric = {
  label: string;
  your: number;
  competitor: number;
  source: string;
};

type CompetitorIntelligenceItem = {
  competitor: CompetitorRow;
  selectedCompetitorOverview: string;
  selectedCompetitorProducts: string[];
  executiveSummary: SummaryCard[];
  kpis: KpiCard[];
  competitorSnapshotCards: SnapshotCard[];
  baselineCategories: BaselineCategory[];
  comparisonMetrics: ComparisonMetric[];
  battlePlanActions: BattleAction[];
  evidenceItems: EvidenceItem[];
  changeTrackingItems: ChangeTrackingItem[];
  workflowActions: WorkflowAction[];
  ownBaselineScore: number;
  competitorBaselineScore: number;
  battleReadinessScore: number;
  currentConfidence: number;
  marketScore: number;
  visibilityScore: number;
  priorityScore: number;
  intelligenceScore: number;
};

type CompetitorIntelligenceResponse = {
  ownCompanyName: string;
  ownBusinessLabel: string;
  ownCompanyOverview: string;
  companySnapshotCards: SnapshotCard[];
  dataGaps: DataGap[];
  hasLiveWebsite: boolean;
  websiteStats: {
    totalSites: number;
    publishedSites: number;
    verifiedDomains: number;
  };
  competitors: CompetitorIntelligenceItem[];
};

function normalizeRank(value: string, weights: Record<string, number>) {
  return weights[value.trim().toLowerCase()] ?? 0;
}

function scoreFromValue(value: string, weights: Record<string, number>, max: number) {
  const rank = normalizeRank(value, weights);
  return rank > 0 ? Math.round(4 + rank / max * 6) : 0;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(10, Math.round(value)));
}

function averageScore(values: number[]) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function countNonEmpty(values: Array<string | null | undefined>) {
  return values.filter((value) => Boolean(value?.trim())).length;
}

function sumListLengths(values: string[][]) {
  return values.reduce((sum, value) => sum + value.length, 0);
}

function parseGrowthValue(value: string) {
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function readTextValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function readListValue(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => readTextValue(entry)).filter(Boolean) : [];
}

function getRecordData(record: WorkspaceRecord | undefined) {
  return record?.data && typeof record.data === 'object' ? record.data : {};
}

function inferTypeFromTags(tags: string[]) {
  if (tags.includes('direct')) return 'Direct';
  if (tags.includes('indirect')) return 'Indirect';
  if (tags.includes('substitute')) return 'Substitute';
  if (tags.includes('emerging')) return 'Emerging';
  return 'Unknown';
}

function toTitleCase(value: string | null | undefined, fallback: string) {
  if (!value?.trim()) return fallback;
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function getPositionScore(value: string) {
  return scoreFromValue(value, { stronger: 4, parity: 3, equal: 3, weaker: 2, peer: 2, unknown: 1 }, 4);
}

function getVisibilityScore(value: string) {
  return scoreFromValue(value, { dominant: 5, very_high: 4, high: 3, medium: 2, low: 1 }, 5);
}

function getPriorityScore(value: string) {
  return scoreFromValue(value, { critical: 4, high: 3, medium: 2, low: 1 }, 4);
}

function getIntelligenceScore(value: string) {
  return scoreFromValue(value, { full: 3, partial: 2, limited: 1 }, 3);
}

function getConfidenceScore(sourceQuality: string, intelligence: string) {
  const qualityBoost = normalizeRank(sourceQuality, { high: 3, medium: 2, low: 1 });
  const intelligenceBoost = normalizeRank(intelligence, { full: 3, partial: 2, limited: 1 });
  return 55 + qualityBoost * 8 + intelligenceBoost * 7;
}

function competitorTypeLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'unknown') return 'relevanter Marktteilnehmer';
  return `${normalized}er Wettbewerber`;
}

function buildCompetitorRows(
  competitors: Awaited<ReturnType<typeof onboardingRepo.listCompetitors>>,
  competitorRecords: WorkspaceRecord[],
) {
  const recordsByCompetitorId = new Map<string, WorkspaceRecord>();
  const recordsByName = new Map<string, WorkspaceRecord>();
  for (const record of competitorRecords) {
    const data = getRecordData(record);
    const competitorId = readTextValue(data.competitorId);
    const name = (readTextValue(data.name) || record.name || '').trim().toLowerCase();
    if (competitorId) recordsByCompetitorId.set(competitorId, record);
    if (name) recordsByName.set(name, record);
  }

  return competitors.map((competitor, index) => {
    const record = recordsByCompetitorId.get(competitor.id) ?? recordsByName.get(competitor.name.trim().toLowerCase());
    const data = getRecordData(record);
    const type = readTextValue(data.type) || toTitleCase(competitor.competitorType, inferTypeFromTags(record?.tags ?? []));
    const websiteUrl = readTextValue(data.websiteUrl) || competitor.websiteUrl || '';
    const updatedAt = readTextValue(data.updated) || competitor.lastReviewedAt || competitor.updatedAt;
    return {
      n: competitor.name,
      l: competitor.name.slice(0, 1).toUpperCase(),
      c: 'var(--foreground)',
      rank: Number(data.rank ?? index + 1),
      type,
      market: readTextValue(data.market) || competitor.market || 'Market not mapped yet',
      pos: readTextValue(data.position) || 'Peer',
      growth: readTextValue(data.growth) || 'Stable',
      vis: readTextValue(data.visibility) || 'Medium',
      pri: readTextValue(data.priority) || toTitleCase(competitor.strategicPriority, 'High'),
      intel: readTextValue(data.intelligence) || 'Partial',
      when: updatedAt,
      websiteUrl,
      positioning: readTextValue(data.positioning) || competitor.positioning || '',
      strengths: readListValue(data.strengths).length ? readListValue(data.strengths) : competitor.strengths,
      weaknesses: readListValue(data.weaknesses).length ? readListValue(data.weaknesses) : competitor.weaknesses,
      differentiators: readListValue(data.differentiators).length ? readListValue(data.differentiators) : competitor.differentiators,
      featureOverlap: readListValue(data.featureOverlap).length ? readListValue(data.featureOverlap) : competitor.featureOverlap,
      sourceQuality: readTextValue(data.sourceQuality) || toTitleCase(competitor.sourceQuality, 'Medium'),
    } satisfies CompetitorRow;
  }).sort((left, right) => left.rank - right.rank || left.n.localeCompare(right.n)).slice(0, 10);
}

export async function getCompetitorIntelligence(workspaceId: string, userId: string): Promise<CompetitorIntelligenceResponse> {
  const [
    workspace,
    offerings,
    customerSegments,
    platforms,
    onboardingCompetitors,
    sites,
    competitorRecordResult,
  ] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    onboardingRepo.listOfferings(workspaceId),
    onboardingRepo.listCustomerSegments(workspaceId),
    onboardingRepo.listPlatforms(workspaceId),
    onboardingRepo.listCompetitors(workspaceId),
    websiteRepo.listSites(workspaceId),
    recordRepo.listRecords(workspaceId, 'marketing_competitors', { page: 1, limit: 25, sort: 'updatedAt', order: 'desc' }),
  ]);

  const connectedPlatformsCount = platforms.filter((platform) => ['connected', 'active', 'synced', 'authorized'].includes(platform.connectionStatus.trim().toLowerCase())).length;
  const totalDifferentiators = sumListLengths(offerings.map((offering) => offering.differentiators));
  const totalProofPoints = sumListLengths(offerings.map((offering) => offering.proofPoints));
  const totalUseCases = sumListLengths(offerings.map((offering) => offering.useCases));
  const totalPainPoints = sumListLengths(customerSegments.map((segment) => segment.painPoints));
  const totalDecisionCriteria = sumListLengths(customerSegments.map((segment) => segment.decisionCriteria));
  const offeringsWithUrls = offerings.filter((offering) => Boolean(offering.url?.trim())).length;
  const totalSites = sites.length;
  const publishedSites = sites.filter((site) => {
    const status = site.status.trim().toLowerCase();
    return status === 'published' || status === 'live';
  }).length;
  const verifiedDomains = sites.reduce((sum, site) => sum + site.domains.filter((domain) => domain.status.trim().toLowerCase() === 'verified' || Boolean(domain.verifiedAt)).length, 0);
  const hasLiveWebsite = publishedSites > 0 || verifiedDomains > 0;
  const ownCompanyName = workspace.companyName.trim() || 'Your Business';
  const ownBusinessLabel = workspace.businessDescription?.trim() || offerings.length || customerSegments.length ? 'Baseline vorhanden' : 'Onboarding fehlt';
  const ownCompanyOverview = `${ownCompanyName} ist in ${workspace.industry || 'einem noch offenen Markt'} aktiv und adressiert ${workspace.targetMarket || 'noch keinen klaren Zielmarkt'}. ${workspace.valueProposition ? `Value Proposition: ${workspace.valueProposition}. ` : ''}${workspace.usp ? `USP: ${workspace.usp}. ` : ''}${customerSegments.length ? `${customerSegments.length} Kundensegmente und ${offerings.length} Angebote liefern bereits verwertbare Signale.` : 'Es fehlen noch mehr strukturierte Kunden- und Angebotsdaten, um die Analyse voll auszureizen.'}`;

  const companySnapshotCards: SnapshotCard[] = [
    {
      title: 'Positioning Core',
      detail: workspace.valueProposition || workspace.shortBrandDescription || 'Noch keine klare Positionierung im Workspace.',
      footnote: workspace.usp ? `USP: ${workspace.usp}` : 'USP fehlt noch',
    },
    {
      title: 'Audience Map',
      detail: workspace.primaryIcp || workspace.targetMarket || 'Noch kein primärer ICP hinterlegt.',
      footnote: `${customerSegments.length} Segmente · ${totalPainPoints} Pain Points · ${totalDecisionCriteria} Decision Criteria`,
    },
    {
      title: 'Offer System',
      detail: offerings.length ? `${offerings.length} Angebote mit ${totalDifferentiators} Differenzierungs-Signalen und ${totalProofPoints} Proof Points.` : 'Noch keine belastbare Angebotsbasis vorhanden.',
      footnote: `${totalUseCases} Use Cases · ${offeringsWithUrls} verlinkte Angebotsseiten`,
    },
    {
      title: 'Digital Footprint',
      detail: hasLiveWebsite ? `${publishedSites} Live-Sites und ${verifiedDomains} verifizierte Domains vorhanden.` : 'Noch keine harte Live-Praesenz vorhanden.',
      footnote: `${connectedPlatformsCount} verbundene Plattformen · ${workspace.languages.length} Sprachen`,
    },
  ];

  const dataGaps: DataGap[] = [
    {
      title: 'Live Website',
      detail: hasLiveWebsite ? 'Live- oder verifizierte Website vorhanden.' : 'Noch keine live verifizierte Website. Dadurch fehlen harte Search- und Trust-Signale.',
      resolved: hasLiveWebsite,
    },
    {
      title: 'Positioning',
      detail: workspace.valueProposition && workspace.usp ? 'Value Proposition und USP sind hinterlegt.' : 'Value Proposition oder USP fehlen noch als saubere Grundlage fuer Messaging und Vergleichsseiten.',
      resolved: Boolean(workspace.valueProposition && workspace.usp),
    },
    {
      title: 'Offers',
      detail: offerings.length >= 2 && totalProofPoints > 0 ? 'Angebote und Proof Points sind ausreichend dokumentiert.' : 'Mehr Angebotsdetails, Proof Points und URLs wuerden die Analyse deutlich verbessern.',
      resolved: offerings.length >= 2 && totalProofPoints > 0,
    },
    {
      title: 'ICP',
      detail: workspace.primaryIcp && customerSegments.length > 0 ? 'ICP und Kundensegmente sind vorhanden.' : 'Primaerer ICP oder Kundensegmente sind noch zu duenn, um die Go-to-Market-Analyse voll auszureizen.',
      resolved: Boolean(workspace.primaryIcp) && customerSegments.length > 0,
    },
    {
      title: 'Integrations',
      detail: connectedPlatformsCount > 0 ? `${connectedPlatformsCount} Plattformen sind verbunden.` : 'Ohne verbundene Plattformen fehlt Ausfuehrungs- und Performance-Kontext.',
      resolved: connectedPlatformsCount > 0,
    },
  ];

  const competitorRows = buildCompetitorRows(onboardingCompetitors, competitorRecordResult.items);
  const competitors = competitorRows.map((selectedCompetitor) => {
    const selectedCompetitorLabel = selectedCompetitor.n;
    const selectedCompetitorType = selectedCompetitor.type;
    const selectedCompetitorMarket = selectedCompetitor.market;
    const selectedCompetitorPosition = selectedCompetitor.pos;
    const selectedCompetitorGrowth = selectedCompetitor.growth;
    const selectedCompetitorVisibility = selectedCompetitor.vis;
    const selectedCompetitorPriority = selectedCompetitor.pri;
    const selectedCompetitorIntelligence = selectedCompetitor.intel;
    const selectedCompetitorUpdatedAt = selectedCompetitor.when || new Date().toISOString();
    const selectedCompetitorProducts = selectedCompetitor.featureOverlap.length
      ? selectedCompetitor.featureOverlap.slice(0, 4)
      : selectedCompetitor.differentiators.length
        ? selectedCompetitor.differentiators.slice(0, 4)
        : selectedCompetitorType === 'Direct'
          ? ['CRM', 'Marketing Automation', 'Sales Enablement', 'Analytics']
          : selectedCompetitorType === 'Indirect'
            ? ['Workflow Automation', 'Analytics', 'Integrations', 'Collaboration']
            : ['AI Automation', 'Business Intelligence', 'Growth Platform', 'Operations'];

    const competitorVisibilityScore = getVisibilityScore(selectedCompetitorVisibility);
    const competitorPriorityScore = getPriorityScore(selectedCompetitorPriority);
    const competitorIntelligenceScore = getIntelligenceScore(selectedCompetitorIntelligence);
    const competitorMarketPresenceScore = getPositionScore(selectedCompetitorPosition);
    const currentConfidence = getConfidenceScore(selectedCompetitor.sourceQuality, selectedCompetitorIntelligence);
    const selectedCompetitorOverview = `${selectedCompetitorLabel} ist aktuell als ${competitorTypeLabel(selectedCompetitorType)} im Markt ${selectedCompetitorMarket} eingeordnet. ${selectedCompetitor.positioning ? `Positionierung: ${selectedCompetitor.positioning}. ` : ''}Die Live-Daten zeigen ${selectedCompetitorVisibility.toLowerCase()} Sichtbarkeit, ${selectedCompetitorGrowth} Wachstumssignal und ${selectedCompetitorIntelligence.toLowerCase()} Intelligence-Abdeckung.`;

    const baselineCategories: BaselineCategory[] = [
      {
        key: 'positioning',
        label: 'Positioning Clarity',
        yourScore: clampScore(1 + (workspace.valueProposition ? 2 : 0) + (workspace.usp ? 2 : 0) + (workspace.shortBrandDescription ? 1 : 0) + Math.min(2, Math.ceil(workspace.positioningTags.length / 2)) + (countNonEmpty([workspace.mission, workspace.vision]) ? 1 : 0)),
        competitorScore: clampScore(2 + (selectedCompetitor.positioning ? 2 : 0) + Math.min(2, Math.ceil(selectedCompetitor.differentiators.length / 2)) + (selectedCompetitorType === 'Direct' ? 2 : 1) + (selectedCompetitorPosition.toLowerCase() === 'stronger' ? 2 : selectedCompetitorPosition.toLowerCase() === 'parity' || selectedCompetitorPosition.toLowerCase() === 'equal' ? 1 : 0)),
        source: 'Onboarding + observed messaging',
        yourEvidence: workspace.valueProposition || workspace.usp || 'Noch keine starke UVP/USP im Workspace hinterlegt.',
        competitorEvidence: selectedCompetitor.positioning || `${selectedCompetitorLabel} kommuniziert bereits sichtbar im Markt ${selectedCompetitorMarket}.`,
        why: 'Wer die Kategorie sprachlich und strategisch klarer besetzt, gewinnt Vertrauen und Conversion schneller.',
        nextMove: 'UVP, USP und Gegenpositionierung scharfziehen und sofort auf Comparison- und Landing-Pages ausrollen.',
        gap: 0,
        priority: 'Medium',
        fastestWin: true,
      },
      {
        key: 'offer',
        label: 'Offer Strength',
        yourScore: clampScore(1 + Math.min(3, offerings.length) + Math.min(2, Math.ceil(totalDifferentiators / 3)) + Math.min(2, Math.ceil(totalProofPoints / 3)) + Math.min(1, Math.ceil(totalUseCases / 4)) + (offeringsWithUrls > 0 ? 1 : 0)),
        competitorScore: clampScore(2 + Math.min(3, Math.max(selectedCompetitor.featureOverlap.length, selectedCompetitor.differentiators.length)) + Math.min(2, Math.ceil(selectedCompetitor.strengths.length / 2)) + (selectedCompetitorPriority === 'Critical' ? 2 : selectedCompetitorPriority === 'High' ? 1 : 0)),
        source: 'Offer catalog + competitor strengths',
        yourEvidence: offerings.length ? `${offerings.length} Angebote, ${totalDifferentiators} Differenzierungs-Signale und ${totalProofPoints} Proof Points erkannt.` : 'Noch keine belastbare Angebotsstruktur im Workspace.',
        competitorEvidence: selectedCompetitor.strengths[0] || selectedCompetitor.differentiators[0] || `${selectedCompetitorLabel} zeigt bereits ein klareres Marktangebot.`,
        why: 'Ein besser belegtes Angebot erhoeht Closing-Rate, Conversion und Vergleichsgewinn.',
        nextMove: 'Angebote mit Proof Points, Use Cases und klaren URLs aufstocken und Battlecards daraus ableiten.',
        gap: 0,
        priority: 'High',
        fastestWin: false,
      },
      {
        key: 'audience',
        label: 'ICP Coverage',
        yourScore: clampScore(1 + (workspace.primaryIcp ? 2 : 0) + (workspace.targetMarket ? 1 : 0) + Math.min(3, customerSegments.length) + Math.min(2, Math.ceil(totalPainPoints / 4)) + Math.min(1, Math.ceil(totalDecisionCriteria / 4))),
        competitorScore: clampScore(2 + (selectedCompetitorMarket !== 'Market not mapped yet' ? 2 : 0) + (selectedCompetitorPosition.toLowerCase() === 'stronger' ? 2 : 1) + Math.min(2, Math.ceil(selectedCompetitor.featureOverlap.length / 2)) + (selectedCompetitorType === 'Direct' ? 2 : 1)),
        source: 'ICP + market segmentation',
        yourEvidence: workspace.primaryIcp || `${customerSegments.length} Segmente mit ${totalPainPoints} Pain Points hinterlegt.`,
        competitorEvidence: `${selectedCompetitorLabel} ist im Markt ${selectedCompetitorMarket} als ${competitorTypeLabel(selectedCompetitorType)} verortet.`,
        why: 'Besseres ICP-Mapping entscheidet darueber, welche Botschaften, Seiten und Kampagnen wirklich ziehen.',
        nextMove: 'Primaeren ICP, Buying Roles und Pain Points verdichten und in GEO-, SEO- und Sales-Artefakte uebersetzen.',
        gap: 0,
        priority: 'High',
        fastestWin: true,
      },
      {
        key: 'trust',
        label: 'Trust & Proof',
        yourScore: clampScore(1 + (hasLiveWebsite ? 2 : 0) + Math.min(2, verifiedDomains) + Math.min(2, Math.ceil(totalProofPoints / 4)) + (workspace.foundingYear ? 1 : 0) + (connectedPlatformsCount > 0 ? 1 : 0) + (workspace.annualRevenueRange ? 1 : 0)),
        competitorScore: clampScore(2 + (selectedCompetitor.sourceQuality === 'High' ? 3 : selectedCompetitor.sourceQuality === 'Medium' ? 2 : 1) + Math.min(2, Math.ceil(selectedCompetitor.strengths.length / 2)) + (selectedCompetitor.websiteUrl ? 1 : 0) + (selectedCompetitorIntelligence === 'Full' ? 2 : selectedCompetitorIntelligence === 'Partial' ? 1 : 0)),
        source: 'Website + proof signals',
        yourEvidence: hasLiveWebsite ? `${publishedSites} Live-Site(s), ${verifiedDomains} verifizierte Domain(s) und ${totalProofPoints} Proof Points erkannt.` : 'Noch kein belastbares Live- oder Proof-Signal vorhanden.',
        competitorEvidence: `${selectedCompetitorLabel} hat ${selectedCompetitor.sourceQuality} Source Quality und ${selectedCompetitor.strengths.length} sichtbare Staerken.`,
        why: 'Trust-Signale sind oft der schnellste Hebel, um gegen etablierte Wettbewerber zu kontern.',
        nextMove: 'Live-Praesenz, Proof Points, Referenzen und Trust-Elemente systematisch ausbauen.',
        gap: 0,
        priority: 'High',
        fastestWin: true,
      },
      {
        key: 'distribution',
        label: 'Distribution Readiness',
        yourScore: clampScore(1 + (hasLiveWebsite ? 3 : 0) + Math.min(2, connectedPlatformsCount) + Math.min(2, offeringsWithUrls) + Math.min(1, publishedSites) + Math.min(1, Math.ceil(workspace.languages.length / 2))),
        competitorScore: clampScore(2 + competitorVisibilityScore + (parseGrowthValue(selectedCompetitorGrowth) > 0 ? 1 : 0)),
        source: 'Website + platform connections',
        yourEvidence: `${totalSites} Website(s), ${connectedPlatformsCount} verbundene Plattformen und ${offeringsWithUrls} verlinkte Angebote.`,
        competitorEvidence: `${selectedCompetitorLabel} zeigt ${selectedCompetitorVisibility.toLowerCase()} Visibility und ${selectedCompetitorGrowth} Wachstum.`,
        why: 'Ohne Distribution gewinnt selbst das beste Produkt nicht schnell genug Marktanteil.',
        nextMove: 'Core Pages live bringen, Such- und Answer-Flaechen besetzen und Distributionskanaele hart automatisieren.',
        gap: 0,
        priority: 'High',
        fastestWin: hasLiveWebsite,
      },
      {
        key: 'execution',
        label: 'Execution Velocity',
        yourScore: clampScore(1 + (workspace.onboardingCompletedAt ? 1 : 0) + Math.min(2, connectedPlatformsCount) + Math.min(2, offerings.length) + Math.min(2, customerSegments.length) + Math.min(1, totalSites) + (workspace.planKey === 'ai' || workspace.planKey === 'test' ? 2 : 1)),
        competitorScore: clampScore(2 + competitorPriorityScore + Math.min(2, Math.ceil(Math.max(parseGrowthValue(selectedCompetitorGrowth), 0) / 10)) + (selectedCompetitorIntelligence === 'Full' ? 2 : selectedCompetitorIntelligence === 'Partial' ? 1 : 0)),
        source: 'Operational readiness',
        yourEvidence: `${offerings.length} Angebote, ${customerSegments.length} Segmente, ${connectedPlatformsCount} Integrationen und Plan ${workspace.planKey ?? 'unbekannt'}.`,
        competitorEvidence: `${selectedCompetitorLabel} ist ${selectedCompetitorPriority} priorisiert, waechst mit ${selectedCompetitorGrowth} und hat ${selectedCompetitorIntelligence} Intelligence.`,
        why: 'Geschwindigkeit entscheidet, ob du Luecken vor dem Markt schliessen kannst oder nur reagierst.',
        nextMove: 'Mehr Inputs automatisiert verbinden und daraus wiederkehrende Execution-Loops ohne Handarbeit starten.',
        gap: 0,
        priority: 'Medium',
        fastestWin: false,
      },
    ].map((category) => {
      const gap = category.competitorScore - category.yourScore;
      return {
        ...category,
        gap,
        priority: gap >= 3 ? 'High' : gap > 0 ? 'Medium' : 'Low',
      };
    });

    const ownBaselineScore = averageScore(baselineCategories.map((category) => category.yourScore));
    const competitorBaselineScore = averageScore(baselineCategories.map((category) => category.competitorScore));
    const battleReadinessScore = clampScore(10 - Math.max(0, ...baselineCategories.map((category) => category.gap), 0));
    const biggestGapCategory = [...baselineCategories].sort((left, right) => right.gap - left.gap)[0] ?? null;
    const fastestWinCategory = [...baselineCategories]
      .filter((category) => category.gap > 0)
      .sort((left, right) => Number(right.fastestWin) - Number(left.fastestWin) || right.gap - left.gap)[0] ?? null;

    const executiveSummary: SummaryCard[] = [
      {
        label: 'Own Baseline',
        value: `${ownBaselineScore}/10`,
        detail: `${ownCompanyName} hat aktuell eine belastbare Ausgangsbasis aus ${offerings.length} Angeboten, ${customerSegments.length} Segmenten und ${connectedPlatformsCount} Plattformen.`,
        tone: ownBaselineScore >= competitorBaselineScore ? 'green' : 'amber',
        action: ownBaselineScore >= competitorBaselineScore ? 'Momentum ausbauen und schneller ausrollen' : 'Fundament verdichten und kritische Luecken schliessen',
      },
      {
        label: 'Competitor Pressure',
        value: `${competitorBaselineScore}/10`,
        detail: `${selectedCompetitorLabel} setzt aktuell den Druck ueber ${selectedCompetitorPriority.toLowerCase()}e Prioritaet und ${selectedCompetitorVisibility.toLowerCase()}e Sichtbarkeit.`,
        tone: 'red',
        action: 'Gegenpositionierung, Proof und Distribution priorisieren',
      },
      {
        label: 'Biggest Gap',
        value: biggestGapCategory?.label ?? '—',
        detail: biggestGapCategory ? `${biggestGapCategory.competitorScore}/10 vs ${biggestGapCategory.yourScore}/10. ${biggestGapCategory.why}` : 'Noch kein Gap berechnet.',
        tone: biggestGapCategory?.gap && biggestGapCategory.gap > 0 ? 'red' : 'green',
        action: biggestGapCategory?.nextMove ?? 'Weitere Daten sammeln',
      },
      {
        label: 'Fastest Win',
        value: fastestWinCategory?.label ?? '—',
        detail: fastestWinCategory ? `Schnellster Hebel mit ${fastestWinCategory.priority} Prioritaet gegen ${selectedCompetitorLabel}.` : 'Zurzeit kein klarer Schnellgewinn offen.',
        tone: fastestWinCategory ? 'green' : 'purple',
        action: fastestWinCategory?.nextMove ?? 'Fundament weiter ausbauen',
      },
    ];

    const kpis: KpiCard[] = [
      { title: 'Own Score', value: `${ownBaselineScore}/10`, sub: 'Aktuelle Unternehmens-Baseline', icon: 'Sparkles' },
      { title: 'Competitor Score', value: `${competitorBaselineScore}/10`, sub: 'Druck durch Fokus-Wettbewerber', icon: 'AlertTriangle' },
      { title: 'Gap Categories', value: `${baselineCategories.filter((category) => category.gap > 0).length}`, sub: 'Bereiche mit offenem Rueckstand', icon: 'Activity' },
      { title: 'Data Gaps', value: `${dataGaps.filter((item) => !item.resolved).length}`, sub: 'Blocker fuer noch bessere Analyse', icon: 'Target' },
      { title: 'Web Presence', value: hasLiveWebsite ? `${publishedSites || verifiedDomains}` : '0', sub: hasLiveWebsite ? 'Live-/verifizierte Website-Signale' : 'Noch nicht live verifiziert', icon: 'Users' },
      { title: 'Battle Readiness', value: `${battleReadinessScore}/10`, sub: 'Wie schnell Lulu zur Offensive gehen kann', icon: 'TrendingUp' },
    ];

    const competitorSnapshotCards: SnapshotCard[] = [
      {
        title: 'Market Pressure',
        detail: `${selectedCompetitorLabel} ist als ${competitorTypeLabel(selectedCompetitorType)} in ${selectedCompetitorMarket} eingeordnet.`,
        footnote: `${selectedCompetitorPriority} Priority · ${selectedCompetitorGrowth} Growth`,
      },
      {
        title: 'Visibility Signals',
        detail: `${selectedCompetitorVisibility} Visibility mit ${selectedCompetitorIntelligence} Intelligence-Tiefe.`,
        footnote: selectedCompetitorUpdatedAt,
      },
      {
        title: 'Messaging',
        detail: selectedCompetitor.positioning || 'Noch kein klares Positioning-Signal im Datensatz.',
        footnote: selectedCompetitor.differentiators[0] || 'Differenzierungs-Signale fehlen',
      },
      {
        title: 'Offer Pressure',
        detail: selectedCompetitor.strengths[0] || selectedCompetitor.featureOverlap[0] || 'Noch keine klaren Angebotsstaerken im Datensatz.',
        footnote: `${selectedCompetitor.strengths.length} Staerken · ${selectedCompetitor.weaknesses.length} Schwaechen`,
      },
    ];

    const battlePlanActions: BattleAction[] = baselineCategories
      .filter((category) => category.gap > 0)
      .sort((left, right) => Number(right.fastestWin) - Number(left.fastestWin) || right.gap - left.gap)
      .map((category) => ({
        title: `${category.label} offensiv schliessen`,
        detail: category.nextMove,
        impact: category.gap >= 3 ? 'High' : category.gap > 1 ? 'Medium' : 'Low',
        speed: category.fastestWin ? 'Fast' : category.key === 'offer' || category.key === 'execution' ? 'Strategic' : 'Medium',
        category: category.label,
        outcome: category.key === 'positioning'
          ? `Klare Gegenpositionierung gegen ${selectedCompetitorLabel}`
          : category.key === 'offer'
            ? 'Mehr Conversion und bessere Sales-Battlecards'
            : category.key === 'audience'
              ? 'Schaerferes ICP-Mapping fuer SEO, GEO und Sales'
              : category.key === 'trust'
                ? 'Mehr Vertrauenssignale und weniger Reibung im Funnel'
                : category.key === 'distribution'
                  ? 'Schnellerer Sichtbarkeitsaufbau ueber alle Kanaele'
                  : 'Hoehere operative Schlagzahl ohne Handarbeit',
      }));

    const evidenceItems: EvidenceItem[] = [
      {
        title: 'Website Positioning',
        source: 'Competitor Website',
        category: 'Observed',
        confidence: 'High',
        updated: selectedCompetitorUpdatedAt,
        detail: selectedCompetitor.positioning || `${selectedCompetitorLabel} kommuniziert ${selectedCompetitorPosition.toLowerCase()} im Markt ${selectedCompetitorMarket}.`,
        why: 'Hilft dir, Gegennarrative und Comparison Pages direkt auf die sichtbare Positionierung auszurichten.',
        link: selectedCompetitor.websiteUrl,
      },
      {
        title: 'SEO, GEO, AEO, Content und Advertising Footprint',
        source: 'Search Surface Signals',
        category: 'AI Inferred',
        confidence: currentConfidence >= 85 ? 'High' : currentConfidence >= 70 ? 'Medium' : 'Low',
        updated: selectedCompetitorUpdatedAt,
        detail: `${selectedCompetitorLabel} zeigt ${selectedCompetitorVisibility.toLowerCase()} Sichtbarkeit im aktuellen Fokusmix.`,
        why: 'Zeigt, wo du kurzfristig Sichtbarkeit oder Share of Voice gewinnen kannst.',
        link: selectedCompetitor.websiteUrl,
      },
      {
        title: 'Content and Messaging',
        source: 'Category Messaging Review',
        category: 'AI Inferred',
        confidence: 'Medium',
        updated: selectedCompetitorUpdatedAt,
        detail: selectedCompetitor.differentiators[0] ? `${selectedCompetitorLabel} differenziert sich aktuell ueber ${selectedCompetitor.differentiators[0].toLowerCase()}.` : `${selectedCompetitorLabel} priorisiert aktuell Messaging rund um Marktposition und Differenzierung.`,
        why: 'Perfekt fuer Gegenpositionierung, Landing Pages und GEO/AEO-Briefs.',
        link: selectedCompetitor.websiteUrl,
      },
      {
        title: 'Priority and Timing',
        source: 'Workspace Intelligence',
        category: 'Observed',
        confidence: 'High',
        updated: selectedCompetitorUpdatedAt,
        detail: `${selectedCompetitorLabel} ist mit Prioritaet ${selectedCompetitorPriority}, Wachstum ${selectedCompetitorGrowth} und Source Quality ${selectedCompetitor.sourceQuality} markiert.`,
        why: 'Hilft bei der Reihenfolge fuer Monitoring, Content-Produktion und Sales Enablement.',
        link: selectedCompetitor.websiteUrl,
      },
    ];

    const changeTrackingItems: ChangeTrackingItem[] = [
      {
        title: `${selectedCompetitorLabel} gewinnt Momentum`,
        when: 'vor 2 Tagen',
        impact: 'High',
        detail: `${selectedCompetitorGrowth} Wachstumssignal und steigende Sichtbarkeit im Markt ${selectedCompetitorMarket}.`,
      },
      {
        title: 'Groesste offene Luecke',
        when: 'jetzt',
        impact: biggestGapCategory?.gap && biggestGapCategory.gap > 0 ? 'High' : 'Medium',
        detail: biggestGapCategory ? `${biggestGapCategory.label}: ${biggestGapCategory.competitorScore}/10 vs ${biggestGapCategory.yourScore}/10.` : 'Noch kein priorisierter Gap berechnet.',
      },
      {
        title: 'Messaging-Signal geaendert',
        when: 'vor 5 Tagen',
        impact: 'Medium',
        detail: `${selectedCompetitorLabel} schiebt Marktposition und Sichtbarkeit staerker in den Vordergrund.`,
      },
      {
        title: 'Schnellster Win offen',
        when: 'vor 7 Tagen',
        impact: 'High',
        detail: fastestWinCategory ? `${fastestWinCategory.label} laesst sich gegen ${selectedCompetitorLabel} am schnellsten drehen.` : `${selectedCompetitorLabel} laesst noch genuegend Luecken fuer Comparison- und GEO-Content.`,
      },
      {
        title: 'Data quality',
        when: 'laufend',
        impact: 'Medium',
        detail: `${dataGaps.filter((item) => !item.resolved).length} Analyse-Blocker verhindern noch eine vollstaendige 360-Grad-Bewertung von ${ownCompanyName}.`,
      },
    ];

    const workflowActions: WorkflowAction[] = [
      {
        label: 'Self Intelligence Loop',
        detail: `${ownCompanyName} wird kontinuierlich auf Positionierung, Angebote, ICP, Proof und Distribution abgeglichen.`,
        cadence: 'Every cycle',
        output: `Aktualisierte Own-Baseline und Data-Gap-Liste fuer ${ownCompanyName}`,
      },
      {
        label: 'Competitor Intelligence Loop',
        detail: `Lulu sammelt fortlaufend neue Signale zu ${selectedCompetitorLabel}, priorisiert Bewegungen und aktualisiert die Gap-Analyse.`,
        cadence: 'Continuous',
        output: 'Frische Wettbewerbs-Signale, Bewegungen und neue Angriffsflaechen',
      },
      {
        label: 'Gap Closure Loop',
        detail: 'Die groessten Rueckstaende werden direkt in SEO-, GEO-, AEO-, Website- und Sales-Artefakte uebersetzt.',
        cadence: 'Continuous',
        output: biggestGapCategory ? `${biggestGapCategory.label} wird mit priorisierten Execution-Tasks angegriffen` : 'Keine offene Hauptluecke',
      },
      {
        label: 'Comparison Content Loop',
        detail: `Lulu baut und verbessert automatisch Comparison Pages, Gegenargumente und Trust-Signale gegen ${selectedCompetitorLabel}.`,
        cadence: 'Always on',
        output: `${selectedCompetitorLabel} comparison messaging, pages und counter-proof`,
      },
      {
        label: 'Sales Battlecard Loop',
        detail: `Sales bekommt laufend aktualisierte Argumente, Einwandbehandlung und Win-Strategien gegen ${selectedCompetitorLabel}.`,
        cadence: 'Daily refresh',
        output: 'Battlecards, objection handling und win-the-deal angles',
      },
      {
        label: 'Re-measurement Loop',
        detail: `Nach jeder Optimierung misst Lulu neu, ob ${ownCompanyName} naeher an Platz 1 kommt oder wo noch neue Luecken entstehen.`,
        cadence: 'Continuous',
        output: 'Neue Baselines, Prioritaeten und naechste Angriffswellen',
      },
    ];

    return {
      competitor: selectedCompetitor,
      selectedCompetitorOverview,
      selectedCompetitorProducts,
      executiveSummary,
      kpis,
      competitorSnapshotCards,
      baselineCategories,
      comparisonMetrics: baselineCategories.map((category) => ({
        label: category.label,
        your: category.yourScore,
        competitor: category.competitorScore,
        source: category.source,
      })),
      battlePlanActions,
      evidenceItems,
      changeTrackingItems,
      workflowActions,
      ownBaselineScore,
      competitorBaselineScore,
      battleReadinessScore,
      currentConfidence,
      marketScore: competitorMarketPresenceScore || 5,
      visibilityScore: competitorVisibilityScore || 5,
      priorityScore: competitorPriorityScore || 5,
      intelligenceScore: competitorIntelligenceScore || 4,
    } satisfies CompetitorIntelligenceItem;
  });

  return {
    ownCompanyName,
    ownBusinessLabel,
    ownCompanyOverview,
    companySnapshotCards,
    dataGaps,
    hasLiveWebsite,
    websiteStats: {
      totalSites,
      publishedSites,
      verifiedDomains,
    },
    competitors,
  };
}
