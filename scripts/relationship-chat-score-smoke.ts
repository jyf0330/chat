import {
  applyGameRound,
  createInitialGameState,
  normalizeJudge,
  type GameState,
} from "./relationship-chat-game.ts";

const idealJudge = {
  boundary_score: 5,
  risk_score: 5,
  pressure_score: 5,
  trust_score: 5,
  empathy_score: 5,
  relevance_score: 5,
  risk_level_after: "low",
  verdict: "理想回复。",
};

const boundaryBreakJudge = {
  boundary_score: -5,
  risk_score: -5,
  pressure_score: -5,
  trust_score: -5,
  empathy_score: -5,
  relevance_score: -5,
  risk_level_after: "blocked",
  verdict: "严重越界。",
};

function stateAt(score: number): GameState {
  return {
    ...createInitialGameState(),
    turn_count: score === 0 ? 0 : 4,
    score,
    highest_score: Math.max(0, score),
    rounds:
      score === 0
        ? []
        : [
            {
              turn: 4,
              score_before: score,
              raw_score: 0,
              display_score: 0,
              score_delta: 0,
              score_after: score,
              title_after: "验证状态",
              judge: normalizeJudge({ risk_level_after: "low", verdict: "验证状态。" }),
              verdict: "验证状态。",
            },
          ],
  };
}

const rows = [0, 35, 45, 68, 82, 94].map((score) => {
  const next = applyGameRound(stateAt(score), idealJudge);
  const round = next.rounds.at(-1)!;
  return {
    before: score,
    rawRound: round.raw_score,
    visibleDelta: round.score_delta,
    after: next.score,
  };
});

const severe = applyGameRound(stateAt(45), boundaryBreakJudge);

console.table(rows);
console.log("severe_boundary_break_from_45", {
  before: 45,
  delta: severe.rounds.at(-1)?.score_delta,
  after: severe.score,
});
