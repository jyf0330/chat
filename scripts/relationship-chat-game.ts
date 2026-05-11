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

export type GameRound = {
  turn: number;
  score_before: number;
  raw_score: number;
  display_score: number;
  score_delta: number;
  score_after: number;
  title_after: string;
  judge: NormalizedJudge;
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
  completion_reason: null | "max_turns" | "blocked" | "score_floor" | "score_ceiling";
  rounds: GameRound[];
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

  return ranked[0]?.entry.title ?? titleForScore(score);
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

export function applyGameRound(previous: GameState | undefined, judgeInput: unknown): GameState {
  const state = normalizeGameState(previous);
  if (state.is_complete) return state;

  const judge = normalizeJudge(judgeInput);
  const scoreBefore = state.score;
  const rawScore = calculateRawScore(judge);
  const scoreDelta = calculateScoreDelta(state, judge);
  const displayScore = scoreDelta;
  const scoreAfter = calculateScoreAfter(state, judge);
  const turn = state.turn_count + 1;
  const highestScore = Math.max(state.highest_score, scoreAfter);
  const completionReason = completionReasonFor(turn, scoreAfter);
  const rounds = [
    ...state.rounds,
    {
      turn,
      score_before: scoreBefore,
      raw_score: rawScore,
      display_score: displayScore,
      score_delta: scoreDelta,
      score_after: scoreAfter,
      title_after: titleForScore(scoreAfter),
      judge,
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

function completionReasonFor(turn: number, score: number): GameState["completion_reason"] {
  if (turn < GAME_MIN_TURNS_BEFORE_EARLY_END) return null;
  if (score <= -100) return "score_floor";
  if (score >= 100) return "score_ceiling";
  if (turn >= GAME_MAX_TURNS) return "max_turns";
  return null;
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
