import { readFileSync } from "node:fs";

export const GAME_MAX_TURNS = 10;
export const GAME_MIN_TURNS_BEFORE_EARLY_END = 3;
export const SCORE_SCHEMA_VERSION = "relationship_game_score_v1";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type RelationshipJudge = {
  risk_level_after?: string;
  boundary_score?: number;
  pressure_score?: number;
  trust_score?: number;
  empathy_score?: number;
  relevance_score?: number;
  risk_score?: number;
  evidence?: string[];
  verdict?: string;
};

export type NormalizedJudge = {
  risk_level_after: RiskLevel;
  boundary_score: number;
  pressure_score: number;
  trust_score: number;
  empathy_score: number;
  relevance_score: number;
  risk_score: number;
  evidence: string[];
  verdict: string;
};

export type SafetyGateLevel = "clear" | "caution" | "high_risk" | "blocked";
export type ReplyQualityLevel = "unsafe" | "weak" | "acceptable" | "good" | "excellent";

export type ScoreBreakdown = {
  schema_version: "relationship_game_scoring_v2";
  safety_gate: SafetyGateLevel;
  safety_reasons: string[];
  reply_quality_score: number;
  reply_quality_level: ReplyQualityLevel;
  relationship_delta_score: number;
  raw_score: number;
  score_delta: number;
  evidence_conflict: boolean;
  applied_adjustments: string[];
  dimension_weights: {
    boundary: number;
    risk: number;
    pressure: number;
    trust: number;
    empathy: number;
    relevance: number;
  };
};

export type GameRound = {
  turn: number;
  user_reply?: string;
  score_before: number;
  raw_score: number;
  display_score: number;
  score_delta: number;
  score_after: number;
  title_after: string;
  judge: NormalizedJudge;
  score_breakdown?: ScoreBreakdown;
  verdict: string;
};

export type GameState = {
  schema_version: typeof SCORE_SCHEMA_VERSION;
  max_turns: typeof GAME_MAX_TURNS;
  turn_count: number;
  score: number;
  title: string;
  highest_score: number;
  highest_title: string;
  is_complete: boolean;
  completion_reason: null | "max_turns" | "blocked" | "score_floor" | "score_ceiling" | "stale_loop" | "natural_end";
  rounds: GameRound[];
};

export type ApplyGameRoundOptions = {
  userReply?: string;
  nextSuggestion?: string;
};

export type TitleBand = {
  min: number;
  max: number;
  title: string;
};

export type TitleCatalogEntry = {
  id: string;
  title: string;
  tone: "positive" | "negative";
  score_min: number;
  score_max: number;
  tags: string[];
};

type TitleCatalog = {
  schema_version: string;
  titles: TitleCatalogEntry[];
};

export const TITLE_BANDS: TitleBand[] = [
  { min: -100, max: -70, title: "关系崩盘" },
  { min: -69, max: -30, title: "高压失控" },
  { min: -29, max: 0, title: "谨慎修复" },
  { min: 1, max: 30, title: "稳定对话" },
  { min: 31, max: 70, title: "信任升温" },
  { min: 71, max: 100, title: "高质量陪伴" },
];

const titleCatalog = loadTitleCatalog();
const TITLE_TAG_WEIGHTS: Record<string, number> = {
  blocked: 8,
  severe_negative: 7,
  high_score: 7,
  perfect: 7,
  boundary_broken: 6,
  boundary_respected: 6,
  pressure_added: 5,
  pressure_lowered: 5,
  trust_damaged: 5,
  trust_built: 5,
  empathy: 4,
  empathy_low: 4,
  safe_exit: 4,
  comeback: 4,
  relevant: 3,
  relevant_low: 3,
  warmth: 3,
  sustained: 3,
  high_risk: 2,
  stable_score: 1,
  positive_score: 1,
  negative_score: 1,
};
const TITLE_SELECTION_WEIGHT_WINDOW = 4;
const TITLE_SELECTION_MIN_POOL_SIZE = 8;

export function createInitialGameState(): GameState {
  return {
    schema_version: SCORE_SCHEMA_VERSION,
    max_turns: GAME_MAX_TURNS,
    turn_count: 0,
    score: 0,
    title: titleForScore(0),
    highest_score: 0,
    highest_title: titleForScore(0),
    is_complete: false,
    completion_reason: null,
    rounds: [],
  };
}

export function titleForScore(score: number) {
  const clamped = clampScore(score);
  return TITLE_BANDS.find((band) => clamped >= band.min && clamped <= band.max)?.title ?? "谨慎修复";
}

export function titleForGame(input: GameState | undefined) {
  const state = normalizeGameStateForTitle(input);
  const tags = processTagsForGame(state);
  const score = clampScore(state.score);
  const usedTitles = titlesUsedBeforeCurrentRound(state);
  const candidates = titleCatalog.titles.filter((entry) => score >= entry.score_min && score <= entry.score_max);
  if (!candidates.length) return titleForScore(score);

  const ranked = candidates
    .map((entry, index) => ({
      entry,
      index,
      matchCount: entry.tags.filter((tag) => tags.includes(tag)).length,
      matchWeight: entry.tags
        .filter((tag) => tags.includes(tag))
        .reduce((sum, tag) => sum + (TITLE_TAG_WEIGHTS[tag] ?? 1), 0),
      toneMatch:
        (score > 0 && entry.tone === "positive") ||
        (score <= 0 && entry.tone === "negative"),
    }))
    .sort((a, b) => {
      if (b.matchWeight !== a.matchWeight) return b.matchWeight - a.matchWeight;
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (Number(b.toneMatch) !== Number(a.toneMatch)) return Number(b.toneMatch) - Number(a.toneMatch);
      return a.index - b.index;
    });

  const bestWeight = ranked[0]?.matchWeight ?? 0;
  const strongCandidates = ranked.filter(
    (candidate) =>
      candidate.toneMatch &&
      candidate.matchWeight > 0 &&
      candidate.matchWeight >= Math.max(1, bestWeight - TITLE_SELECTION_WEIGHT_WINDOW),
  );
  const baseSelectable = strongCandidates.length
    ? strongCandidates
    : ranked.filter((candidate) => candidate.toneMatch).slice(0, TITLE_SELECTION_MIN_POOL_SIZE);
  const selectable = prioritizedTitleCandidates(baseSelectable, tags);
  const unusedSelectable = selectable.filter((candidate) => !usedTitles.has(candidate.entry.title));
  const selectionPool = unusedSelectable.length ? unusedSelectable : selectable;
  const selected = selectionPool[stableHash(gameTitleSeed(state, tags)) % selectionPool.length];

  return selected?.entry.title ?? ranked[0]?.entry.title ?? titleForScore(score);
}

export function processTagsForGame(input: GameState | undefined) {
  const state = normalizeGameStateForTitle(input);
  const rounds = state.rounds;
  const tags = new Set<string>();
  const score = clampScore(state.score);

  if (score >= 71) tags.add("high_score");
  else if (score >= 31) tags.add("positive_score");
  else if (score > 0) tags.add("stable_score");
  else tags.add("negative_score");

  if (score <= -70) tags.add("severe_negative");
  if (state.completion_reason === "score_ceiling" || score >= 100) tags.add("perfect");
  if (state.completion_reason === "max_turns" && score > 30) tags.add("sustained");
  if (rounds.some((round) => round.judge.risk_level_after === "high" || round.judge.risk_level_after === "blocked")) {
    tags.add("high_risk");
  }
  if (state.completion_reason === "blocked" || rounds.some((round) => round.judge.risk_level_after === "blocked")) {
    tags.add("blocked");
  }

  if (!rounds.length) return [...tags];

  const allBoundaryClear = rounds.every((round) => round.judge.boundary_score >= 0);
  const anyBoundaryBroken = rounds.some((round) => round.judge.boundary_score < 0);
  if (allBoundaryClear) tags.add("boundary_respected");
  if (anyBoundaryBroken) tags.add("boundary_broken");

  const averagePressureScore = average(rounds.map((round) => round.judge.pressure_score));
  const averageTrustScore = average(rounds.map((round) => round.judge.trust_score));
  const averageEmpathyScore = average(rounds.map((round) => round.judge.empathy_score));
  const averageRelevanceScore = average(rounds.map((round) => round.judge.relevance_score));
  const worstRoundDelta = Math.min(...rounds.map((round) => round.score_delta));

  if (averagePressureScore >= 2) tags.add("pressure_lowered");
  if (averagePressureScore <= -2) tags.add("pressure_added");
  if (averageTrustScore >= 2) tags.add("trust_built");
  if (averageTrustScore <= -2) tags.add("trust_damaged");
  if (averageEmpathyScore >= 2) tags.add("empathy");
  if (averageEmpathyScore <= -2) tags.add("empathy_low");
  if (averageRelevanceScore >= 2) tags.add("relevant");
  if (averageRelevanceScore <= -2) tags.add("relevant_low");
  if (worstRoundDelta <= -20 && score > 0) tags.add("comeback");
  if (allBoundaryClear && averagePressureScore >= 2 && rounds.some((round) => round.judge.risk_level_after !== "low")) {
    tags.add("safe_exit");
  }
  if (averageTrustScore >= 2 && averageEmpathyScore >= 2) tags.add("warmth");
  if (rounds.some((round) => /道歉|修复|补偿|承认|对不起/.test(round.verdict))) tags.add("repair");

  return [...tags];
}

export function normalizeJudge(input: unknown): NormalizedJudge {
  const judge = isRecord(input) ? input : {};
  const riskLevel = normalizeRisk(judge.risk_level_after);
  const boundaryScore = normalizeScaleScore(judge.boundary_score);
  const pressureScore = normalizeScaleScore(judge.pressure_score);
  const trustScore = normalizeScaleScore(judge.trust_score);
  const empathyScore = normalizeScaleScore(judge.empathy_score);
  const relevanceScore = normalizeScaleScore(judge.relevance_score);
  const riskScore = normalizeRiskScore(judge.risk_score, riskLevel);
  return {
    risk_level_after: riskLevel,
    boundary_score: boundaryScore,
    pressure_score: pressureScore,
    trust_score: trustScore,
    empathy_score: empathyScore,
    relevance_score: relevanceScore,
    risk_score: riskScore,
    evidence: Array.isArray(judge.evidence) ? judge.evidence.filter((item) => typeof item === "string") : [],
    verdict: typeof judge.verdict === "string" ? judge.verdict : "没有返回评语",
  };
}

export function applyGameRound(
  previous: GameState | undefined,
  judgeInput: unknown,
  options: ApplyGameRoundOptions = {},
): GameState {
  const state = normalizeGameState(previous);
  if (state.is_complete) return state;

  const judge = normalizeJudge(judgeInput);
  const userReply = normalizeReplyText(options.userReply);
  const nextSuggestion = normalizeReplyText(options.nextSuggestion);
  const scoreBefore = state.score;
  const scoreBreakdown = buildScoreBreakdown(state, judge, userReply);
  const rawScore = scoreBreakdown.raw_score;
  const scoreDelta = scoreBreakdown.score_delta;
  const displayScore = scoreDelta;
  const scoreAfter = clampScore(state.score + scoreDelta);
  const turn = state.turn_count + 1;
  const highestScore = Math.max(state.highest_score, scoreAfter);
  const completionReason = completionReasonFor(turn, scoreAfter, state, userReply, nextSuggestion);
  const rounds = [
    ...state.rounds,
    {
      turn,
      ...(userReply ? { user_reply: userReply } : {}),
      score_before: scoreBefore,
      raw_score: rawScore,
      display_score: displayScore,
      score_delta: scoreDelta,
      score_after: scoreAfter,
      title_after: titleForScore(scoreAfter),
      judge,
      score_breakdown: scoreBreakdown,
      verdict: judge.verdict,
    },
  ];
  const provisionalState = {
    ...state,
    turn_count: turn,
    score: scoreAfter,
    title: titleForScore(scoreAfter),
    highest_score: highestScore,
    highest_title: titleForScore(highestScore),
    is_complete: completionReason !== null,
    completion_reason: completionReason,
    rounds,
  };
  const titleAfter = titleForGame(provisionalState);

  return {
    ...provisionalState,
    title: titleAfter,
    highest_title: scoreAfter >= state.highest_score ? titleAfter : state.highest_title,
    rounds: rounds.map((round, index) => (index === rounds.length - 1 ? { ...round, title_after: titleAfter } : round)),
  };
}

export function calculateScoreDelta(state: GameState, judge: NormalizedJudge) {
  const roundScore = calculateRawScore(judge);
  if (roundScore <= 0) return roundScore;
  return Math.max(1, Math.round(roundScore * positiveScoreMultiplier(state.score)));
}

export function calculateScoreAfter(state: GameState, judge: NormalizedJudge) {
  return clampScore(state.score + calculateScoreDelta(state, judge));
}

export function buildScoreBreakdown(state: GameState, judge: NormalizedJudge, userReply = ""): ScoreBreakdown {
  const baseRawScore = calculateRawScore(judge);
  const safetyGate = classifySafetyGate(judge, userReply);
  const appliedAdjustments: string[] = [];
  let relationshipDeltaScore = baseRawScore;

  if (safetyGate.level === "blocked" && relationshipDeltaScore > -20) {
    relationshipDeltaScore = -20;
    appliedAdjustments.push("blocked_safety_floor");
  } else if (safetyGate.level === "high_risk" && relationshipDeltaScore > -15) {
    relationshipDeltaScore = -15;
    appliedAdjustments.push("high_risk_safety_floor");
  } else if (safetyGate.level === "caution" && relationshipDeltaScore > 2) {
    relationshipDeltaScore = 2;
    appliedAdjustments.push("caution_positive_cap");
  }

  const scoreDelta =
    relationshipDeltaScore <= 0 ? relationshipDeltaScore : Math.max(1, Math.round(relationshipDeltaScore * positiveScoreMultiplier(state.score)));

  return {
    schema_version: "relationship_game_scoring_v2",
    safety_gate: safetyGate.level,
    safety_reasons: safetyGate.reasons,
    reply_quality_score: calculateReplyQualityScore(judge, safetyGate.level),
    reply_quality_level: qualityLevelForJudge(judge, safetyGate.level),
    relationship_delta_score: relationshipDeltaScore,
    raw_score: relationshipDeltaScore,
    score_delta: scoreDelta,
    evidence_conflict: hasEvidenceConflict(judge, userReply),
    applied_adjustments: appliedAdjustments,
    dimension_weights: {
      boundary: 0.3,
      risk: 0.2,
      pressure: 0.15,
      trust: 0.15,
      empathy: 0.15,
      relevance: 0.05,
    },
  };
}

export function calculateRawScore(judge: NormalizedJudge) {
  const weightedScore =
    judge.boundary_score * 0.3 +
    judge.risk_score * 0.2 +
    judge.pressure_score * 0.15 +
    judge.trust_score * 0.15 +
    judge.empathy_score * 0.15 +
    judge.relevance_score * 0.05;
  const baseScore = Math.round(weightedScore * 2.4);

  if (judge.boundary_score <= -4 || judge.risk_score <= -4) {
    return clampNumber(Math.round(weightedScore * 4), -25, -15);
  }
  if (judge.boundary_score < 0 || judge.risk_score < 0) {
    return clampNumber(baseScore, -12, 2);
  }
  if (judge.relevance_score <= -3) {
    return Math.min(clampNumber(baseScore, -12, 12), 2);
  }

  return clampNumber(baseScore, -12, 12);
}

export function displayScoreForRawScore(rawScore: number) {
  return rawScore;
}

function positiveScoreMultiplier(scoreBefore: number) {
  if (scoreBefore < 40) return 1;
  if (scoreBefore < 70) return 0.85;
  if (scoreBefore < 90) return 0.6;
  return 0.35;
}

function calculateReplyQualityScore(judge: NormalizedJudge, safetyGate: SafetyGateLevel) {
  if (safetyGate === "blocked") return 0;
  if (safetyGate === "high_risk") return Math.min(20, scaledQualityScore(judge));
  if (safetyGate === "caution") return Math.min(55, scaledQualityScore(judge));
  return scaledQualityScore(judge);
}

function scaledQualityScore(judge: NormalizedJudge) {
  const weighted =
    judge.boundary_score * 0.25 +
    judge.risk_score * 0.2 +
    judge.pressure_score * 0.15 +
    judge.trust_score * 0.15 +
    judge.empathy_score * 0.15 +
    judge.relevance_score * 0.1;
  return clampNumber(Math.round(((weighted + 5) / 10) * 100), 0, 100);
}

function qualityLevelForJudge(judge: NormalizedJudge, safetyGate: SafetyGateLevel): ReplyQualityLevel {
  const score = calculateReplyQualityScore(judge, safetyGate);
  if (safetyGate === "blocked" || safetyGate === "high_risk") return "unsafe";
  if (score < 40) return "weak";
  if (score < 65) return "acceptable";
  if (score < 85) return "good";
  return "excellent";
}

function classifySafetyGate(judge: NormalizedJudge, userReply: string) {
  const reasons: string[] = [];
  const text = `${userReply}\n${stripNegatedSafetyEvidence(`${judge.evidence.join("\n")}\n${judge.verdict}`)}`;
  const explicitBlockedPattern = /威胁|恐吓|骚扰|跟踪|堵你|堵门|开盒|查你|人肉|绕过拉黑|换号联系|死给你看|自杀|自残|弄死|杀了|不让你走|必须见我|一直问到|一直缠|辱骂|攻击/;

  if (judge.risk_level_after === "blocked") reasons.push("judge_blocked");
  if (explicitBlockedPattern.test(text)) reasons.push("explicit_high_risk_language");
  if (judge.boundary_score <= -4) reasons.push("boundary_score_severe");
  if (judge.risk_score <= -4) reasons.push("risk_score_severe");

  if (reasons.length) {
    return {
      level: judge.risk_level_after === "blocked" || reasons.includes("explicit_high_risk_language") ? "blocked" as const : "high_risk" as const,
      reasons,
    };
  }

  if (judge.risk_level_after === "high") reasons.push("judge_high_risk");
  if (hasEvidenceConflict(judge, userReply)) reasons.push("evidence_score_conflict");
  if (reasons.length) return { level: "high_risk" as const, reasons };

  if (judge.boundary_score < 0 || judge.risk_score < 0 || judge.pressure_score < 0) {
    return { level: "caution" as const, reasons: ["negative_boundary_risk_or_pressure"] };
  }

  return { level: "clear" as const, reasons: [] };
}

function hasEvidenceConflict(judge: NormalizedJudge, userReply: string) {
  const text = `${userReply}\n${stripNegatedSafetyEvidence(`${judge.evidence.join("\n")}\n${judge.verdict}`)}`;
  const negativeEvidencePattern = /越界|辱骂|攻击|施压|压力|纠缠|威胁|骚扰|无视拒绝|风险升高|需道歉|停止推进|不要继续|高风险|危险/;
  if (!negativeEvidencePattern.test(text)) return false;
  const rawSum =
    judge.boundary_score +
    judge.pressure_score +
    judge.trust_score +
    judge.empathy_score +
    judge.relevance_score +
    judge.risk_score;
  return rawSum >= 0 || judge.boundary_score > 0 || judge.risk_score > 0 || judge.trust_score > 0;
}

function stripNegatedSafetyEvidence(text: string) {
  const safetyTerms = "越界|辱骂|攻击|威胁|纠缠|风险升高|停止推进|需道歉|无视拒绝|情绪勒索|强迫|强行|施压|施加压力|压力|持续追问|高风险|危险";
  return text
    .replace(new RegExp(`(?:没有出现|没有|未出现|未|并非|不是|不含|不包含|无(?!视))[^。；\\n]*(?:${safetyTerms})[^。；\\n]*`, "g"), "")
    .replace(/无风险|低风险|风险低|没有风险/g, "");
}

export function normalizeGameState(input: GameState | undefined): GameState {
  if (!input || !isRecord(input)) return createInitialGameState();
  const score = clampScore(input.score);
  const rounds = Array.isArray(input.rounds) ? input.rounds : [];
  const turnCount = clampNumber(input.turn_count, 0, GAME_MAX_TURNS);
  const highestScore = clampScore(Math.max(input.highest_score ?? score, score));
  return {
    schema_version: SCORE_SCHEMA_VERSION,
    max_turns: GAME_MAX_TURNS,
    turn_count: turnCount,
    score,
    title: typeof input.title === "string" ? input.title : titleForScore(score),
    highest_score: highestScore,
    highest_title: typeof input.highest_title === "string" ? input.highest_title : titleForScore(highestScore),
    is_complete: Boolean(input.is_complete),
    completion_reason: input.completion_reason ?? null,
    rounds: rounds as GameRound[],
  };
}

function normalizeGameStateForTitle(input: GameState | undefined): GameState {
  if (!input || !isRecord(input)) return createInitialGameState();
  const score = clampScore(input.score);
  const highestScore = clampScore(Math.max(input.highest_score ?? score, score));
  return {
    schema_version: SCORE_SCHEMA_VERSION,
    max_turns: GAME_MAX_TURNS,
    turn_count: clampNumber(input.turn_count, 0, GAME_MAX_TURNS),
    score,
    title: typeof input.title === "string" ? input.title : titleForScore(score),
    highest_score: highestScore,
    highest_title: typeof input.highest_title === "string" ? input.highest_title : titleForScore(highestScore),
    is_complete: Boolean(input.is_complete),
    completion_reason: input.completion_reason ?? null,
    rounds: Array.isArray(input.rounds) ? (input.rounds as GameRound[]) : [],
  };
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gameTitleSeed(state: GameState, tags: string[]) {
  return [
    state.score,
    state.turn_count,
    state.completion_reason ?? "active",
    tags.join(","),
    ...state.rounds.map((round) =>
      [
        round.turn,
        round.score_delta,
        round.judge.risk_level_after,
        round.judge.boundary_score,
        round.judge.pressure_score,
        round.judge.trust_score,
        round.judge.empathy_score,
        round.judge.relevance_score,
        round.judge.risk_score,
        round.verdict,
      ].join(":"),
    ),
  ].join("|");
}

function titlesUsedBeforeCurrentRound(state: GameState) {
  return new Set(
    state.rounds
      .slice(0, Math.max(0, state.rounds.length - 1))
      .map((round) => round.title_after)
      .filter(Boolean),
  );
}

function prioritizedTitleCandidates<T extends { entry: TitleCatalogEntry }>(candidates: T[], tags: string[]) {
  if (tags.includes("blocked")) {
    const blockedCandidates = candidates.filter((candidate) => candidate.entry.tags.includes("blocked"));
    if (blockedCandidates.length) return blockedCandidates;
  }
  return candidates;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function loadTitleCatalog(): TitleCatalog {
  try {
    const raw = readFileSync(new URL("../data/relationship-title-catalog.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as TitleCatalog;
    if (!Array.isArray(parsed.titles) || !parsed.titles.length) {
      throw new Error("relationship-title-catalog has no titles");
    }
    return parsed;
  } catch {
    return {
      schema_version: "fallback",
      titles: TITLE_BANDS.map((band, index) => ({
        id: `fallback_${index}`,
        title: band.title,
        tone: band.max <= 0 ? "negative" : "positive",
        score_min: band.min,
        score_max: band.max,
        tags: [],
      })),
    };
  }
}

function completionReasonFor(
  turn: number,
  score: number,
  previous: GameState,
  userReply: string,
  nextSuggestion: string,
): GameState["completion_reason"] {
  if (turn < GAME_MIN_TURNS_BEFORE_EARLY_END) return null;
  if (score <= -100) return "score_floor";
  if (score >= 100) return "score_ceiling";
  if (isStaleLoop(previous, userReply)) return "stale_loop";
  if (isNaturalClosingReply(userReply) || isNaturalClosingSuggestion(nextSuggestion)) return "natural_end";
  if (turn >= GAME_MAX_TURNS) return "max_turns";
  return null;
}

function isStaleLoop(previous: GameState, userReply: string) {
  if (!userReply) return false;
  const lastReply = normalizeReplyText(previous.rounds.at(-1)?.user_reply);
  return Boolean(lastReply && lastReply === userReply);
}

function isNaturalClosingReply(userReply: string) {
  if (!userReply) return false;
  return /晚安|明天(聊|见)|你先忙|先忙|先去忙|忙完(找|再找|再聊)|不打扰|回头聊|晚点(聊|再聊)|早点休息|先休息|下次再聊/.test(userReply);
}

function isNaturalClosingSuggestion(nextSuggestion: string) {
  if (!nextSuggestion) return false;
  if (/无需再发|无需继续|不要再发|对话自然结束|自然结束|停止主动联系|停止联系|不用再继续|不必继续|暂时停止对话/.test(nextSuggestion)) {
    return true;
  }
  return /(等待对方|等对方).*(主动联系|下次联系).*(无需|不用|不必|不要|停止|自然结束|暂时停止).*(发消息|继续|联系|新话题|开启|发起)/.test(
    nextSuggestion,
  );
}

function normalizeReplyText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeRisk(value: unknown): RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "blocked" ? value : "medium";
}

function normalizeScaleScore(value: unknown) {
  const number = finiteNumber(value);
  if (number === null) return 0;
  return clampNumber(Math.round(number), -5, 5);
}

function normalizeRiskScore(value: unknown, risk: RiskLevel) {
  if (finiteNumber(value) !== null) return normalizeScaleScore(value);
  return { low: 2, medium: 0, high: -3, blocked: -5 }[risk];
}

function clampScore(value: unknown) {
  return clampNumber(typeof value === "number" ? Math.round(value) : 0, -100, 100);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
