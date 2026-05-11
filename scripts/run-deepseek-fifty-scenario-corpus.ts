import "dotenv/config";

import { createServer } from "node:http";
import { once } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ChatTurn, RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

type CorpusRunPlanOptions = {
  scenarioCount: number;
  turnsPerScenario: number;
};

export type CorpusScenarioPlan = {
  playerId: string;
  caseId: string;
  currentCase: RelationshipCase;
  replies: string[];
};

export type CorpusTurnResult = {
  turn_index: number;
  http_status: number;
  elapsed_ms: number;
  input_source: "live_deepseek_human_simulator" | "test_planned_human_text";
  actual_user_reply: string;
  expected_reply: string | null;
  matched_deepseek_recommendation: boolean;
  human_simulator?: HumanSimulatorTrace;
  deepseek_input: {
    scene: string;
    fixed_labels: {
      relationship_stage: string;
      target_emotion: string;
      risk_level: string;
    };
    known_bad_reply: string;
    seed_best_strategy: string;
    seed_recommended_reply: string;
    previous_turns: ChatTurn[];
    user_reply: string;
    mode: "chat";
  };
  deepseek_output: Pick<
    SimulationResult,
    "target_reply" | "best_strategy" | "recommended_reply_80" | "perfect_reply_100" | "judge" | "next_suggestion"
  >;
  game: SimulationResult["game"] | null;
  request_contract?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    response_format?: unknown;
  } | null;
  raw_response_meta?: {
    id?: string;
    model?: string;
    usage?: unknown;
  } | null;
  quality: {
    matched_previous_recommendation: boolean;
    duplicate_user_reply: boolean;
    duplicate_target_reply: boolean;
    duplicate_recommended_reply: boolean;
    recommended_equals_perfect: boolean;
    judge_score_contradiction: boolean;
    after_stop_suggestion: boolean;
  };
};

type HumanSimulatorTrace = {
  log_file: string;
  attempts: Array<{
    http_status: number;
    elapsed_ms: number;
    request_contract: {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format: unknown;
    };
    raw_response_meta: {
      id?: string;
      model?: string;
      usage?: unknown;
    } | null;
    raw_reply: string | null;
    rejected_reason: string | null;
  }>;
};

export type CorpusScenarioResult = {
  player_id: string;
  session_id: string | null;
  case_id: string;
  scene: string;
  stage: string;
  emotion: string;
  risk_level: string;
  raw_log_file: string;
  screenshot_path: string | null;
  html_path: string | null;
  completed: boolean;
  stop_reason: string | null;
  final_score: number | null;
  final_title: string | null;
  error: string | null;
  turns: CorpusTurnResult[];
};

type CorpusSummaryInput = {
  runId: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  mode: string;
  deepSeekBaseUrl: string;
  dbFile: string;
  serverPort: number;
  scenarios: CorpusScenarioResult[];
};

const runId = process.env.RELATIONSHIP_CHAT_50X10_RUN_ID ?? timestampRunId();
const requestedCaseIds = parseCaseIds(process.env.RELATIONSHIP_CHAT_50X10_CASE_IDS);
const mergeFromJsonPath = process.env.RELATIONSHIP_CHAT_50X10_MERGE_FROM_JSON ?? null;
const scenarioCount =
  requestedCaseIds.length > 0 ? requestedCaseIds.length : clampNumber(Number(process.env.RELATIONSHIP_CHAT_50X10_SCENARIOS ?? "50"), 50, 200);
const finalScenarioTarget = Number(process.env.RELATIONSHIP_CHAT_50X10_FINAL_SCENARIO_TARGET ?? (mergeFromJsonPath ? "50" : String(scenarioCount)));
const turnsPerScenario = clampNumber(Number(process.env.RELATIONSHIP_CHAT_50X10_TURNS ?? "10"), 10, 10);
const concurrency = clampNumber(Number(process.env.RELATIONSHIP_CHAT_50X10_CONCURRENCY ?? "2"), 1, 6);
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const casesPath = "data/relationship-cases-deepseek.extracted.jsonl";
const outputDir = join("output", "deepseek-50x10-live");
const scenarioHtmlDir = join(outputDir, "scenarios");
const screenshotDir = join("output", "playwright", "deepseek-50x10-live");
const outputJsonPath = join(outputDir, "deepseek-50x10-live.json");
const outputMarkdownPath = join(outputDir, "deepseek-50x10-live.md");
const outputHtmlPath = join(outputDir, "index.html");
const humanSimulatorLogPath = join(outputDir, `human-simulator-${runId}.jsonl`);

export function buildFiftyScenarioRunPlan(cases: RelationshipCase[], options: CorpusRunPlanOptions): CorpusScenarioPlan[] {
  const uniqueCases = uniqueBy(cases, (currentCase) => currentCase.id).slice(0, options.scenarioCount);
  if (uniqueCases.length < options.scenarioCount) {
    throw new Error(`Need ${options.scenarioCount} unique cases, found ${uniqueCases.length}.`);
  }

  return uniqueCases.map((currentCase, scenarioIndex) => ({
    playerId: `deepseek-50x10-${runId}-${String(scenarioIndex + 1).padStart(2, "0")}`,
    caseId: currentCase.id,
    currentCase,
    replies: Array.from({ length: options.turnsPerScenario }, (_, turnIndex) =>
      buildHumanReply({ currentCase, scenarioIndex, turnIndex, previousTargetReply: null }),
    ),
  }));
}

export function buildHumanReply(input: {
  currentCase: RelationshipCase;
  scenarioIndex: number;
  turnIndex: number;
  previousTargetReply: string | null;
}) {
  const sceneSignal = shortSignal(input.previousTargetReply || input.currentCase.real_relationship_scene);
  const stage = input.currentCase.relationship_stage_label;
  const emotion = input.currentCase.target_emotion_label;
  const risk = input.currentCase.risk_level;
  const templates = [
    `我先确认我听到的重点：${sceneSignal}。我不会急着下结论，想先把你的感受放在前面。`,
    `你刚才这句话我会认真对待，尤其是${emotion}这部分。我想先理解你真正介意的点。`,
    `我不想用解释盖过你的感受。关于${stage}这件事，我先说我会把节奏放稳。`,
    `我可以先复述一下我的理解：你需要的是被看见，而不是被我马上推动关系。`,
    `如果我有哪里没接住，你可以直接指出来。我会先听完，再说自己的想法。`,
    `这轮我不辩解，也不把责任推给你。我想把具体边界讲清楚，让你更安心。`,
    `我会注意分寸，尤其现在是${risk}风险，我更应该把安全感放在推进前面。`,
    `我想把话说得具体一点：我会减少追问，先回应你刚才最在意的那部分。`,
    `我理解你不是在为难我，而是在确认我们能不能好好沟通。我愿意慢慢对齐。`,
    `我会把这次对话当成认真修复，不用漂亮话糊弄你；你说到的点我会逐条记住。`,
  ];
  const reply = templates[input.turnIndex % templates.length];
  if (normalize(reply) === normalize(input.currentCase.recommended_reply)) {
    return `${reply} 这不是套话，是我这轮真实要表达的态度。`;
  }
  return reply;
}

export function summarizeCorpusRun(input: CorpusSummaryInput) {
  const allTurns = input.scenarios.flatMap((scenario) => scenario.turns);
  const failures = input.scenarios.filter((scenario) => scenario.error);
  const scenariosWithLessThan10Turns = input.scenarios.filter((scenario) => scenario.turns.length < turnsPerScenario);
  const duplicateCaseCount = input.scenarios.length - new Set(input.scenarios.map((scenario) => scenario.case_id)).size;
  const screenshotCount = input.scenarios.filter((scenario) => scenario.screenshot_path).length;
  const qualityBlockers = allTurns.filter((turn) => Object.values(turn.quality).some(Boolean));
  const httpFailureCount = allTurns.filter((turn) => turn.http_status !== 200).length;
  const nonLiveInputCount = allTurns.filter((turn) => turn.input_source !== "live_deepseek_human_simulator").length;
  const titleDistribution = countBy(input.scenarios.map((scenario) => scenario.final_title ?? "unknown"));
  const scoreDistribution = countBy(input.scenarios.map((scenario) => String(scenario.final_score ?? "unknown")));
  const pass =
    input.mode === "live_deepseek_official" &&
    input.scenarios.length >= finalScenarioTarget &&
    duplicateCaseCount === 0 &&
    scenariosWithLessThan10Turns.length === 0 &&
    allTurns.length >= finalScenarioTarget * turnsPerScenario &&
    httpFailureCount === 0 &&
    nonLiveInputCount === 0 &&
    failures.length === 0 &&
    qualityBlockers.length === 0 &&
    screenshotCount >= finalScenarioTarget;

  return {
    run_id: input.runId,
    mode: input.mode,
    track: "api_virtual_players_with_rendered_screenshots",
    deepseek_base_url: input.deepSeekBaseUrl,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    elapsed_ms: input.elapsedMs,
    server_port: input.serverPort,
    db_file: input.dbFile,
    player_count: input.scenarios.length,
    scenario_count: input.scenarios.length,
    unique_case_count: new Set(input.scenarios.map((scenario) => scenario.case_id)).size,
    duplicate_case_count: duplicateCaseCount,
    turns_per_scenario: turnsPerScenario,
    request_count: allTurns.length,
    completed_game_count: input.scenarios.filter((scenario) => scenario.completed).length,
    failure_count: failures.length,
    http_failure_count: httpFailureCount,
    non_live_input_count: nonLiveInputCount,
    scenarios_with_less_than_10_turns: scenariosWithLessThan10Turns.length,
    quality_blocker_count: qualityBlockers.length,
    screenshot_count: screenshotCount,
    title_distribution: titleDistribution,
    score_distribution: scoreDistribution,
    duplicate_title_explanation:
      "Titles are score-catalog outputs; repeats are expected when multiple live games land in the same score/tag band. See per-scenario final_score/final_title for source.",
    output_json: outputJsonPath,
    output_markdown: outputMarkdownPath,
    output_html: outputHtmlPath,
    screenshot_dir: screenshotDir,
    pass,
  };
}

async function main() {
  if (process.env.RELATIONSHIP_CHAT_50X10_REAUDIT_JSON) {
    reauditExistingPayload(process.env.RELATIONSHIP_CHAT_50X10_REAUDIT_JSON);
    return;
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  assertLiveDeepSeekAvailable();
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(scenarioHtmlDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(".cache", { recursive: true });
  mkdirSync("docs/deepseek-games", { recursive: true });

  const port = await getFreePort();
  const dbFile = resolve(".cache", `relationship-chat-50x10-${runId}.sqlite`);
  await removeSqliteFiles(dbFile);
  const server = startServer(port, dbFile);
  try {
    await waitForServer(port);
    const cases = selectCases(readSeedCases(), requestedCaseIds);
    const plan = buildFiftyScenarioRunPlan(cases, { scenarioCount, turnsPerScenario });
    const repairedScenarios = await runPool(
      plan.map((scenarioPlan, index) => () => runScenario({ baseUrl: `http://127.0.0.1:${port}`, scenarioPlan, index })),
      concurrency,
    );
    const scenarios = mergeFromJsonPath ? mergeScenarios(readMergeScenarios(mergeFromJsonPath), repairedScenarios) : repairedScenarios;
    writeScenarioHtmlFiles(scenarios);
    await screenshotScenarioFiles(scenarios);
    const endedAt = new Date().toISOString();
    const summary = summarizeCorpusRun({
      runId,
      startedAt,
      endedAt,
      elapsedMs: Date.now() - started,
      mode: deepSeekEndpointMode(deepSeekBaseUrl),
      deepSeekBaseUrl,
      dbFile,
      serverPort: port,
      scenarios,
    });
    const payload = { summary, scenarios };
    writeFileSync(outputJsonPath, JSON.stringify(payload, null, 2), "utf8");
    writeFileSync(outputMarkdownPath, buildMarkdown(summary, scenarios), "utf8");
    writeFileSync(outputHtmlPath, buildIndexHtml(summary, scenarios), "utf8");
    console.log(`Wrote ${outputJsonPath}`);
    console.log(`Wrote ${outputMarkdownPath}`);
    console.log(`Wrote ${outputHtmlPath}`);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await stopServer(server);
  }
}

function reauditExistingPayload(path: string) {
  const payload = JSON.parse(readFileSync(path, "utf8")) as {
    summary: ReturnType<typeof summarizeCorpusRun>;
    scenarios: CorpusScenarioResult[];
  };
  for (const scenario of payload.scenarios) recomputeTurnQuality(scenario);
  writeScenarioHtmlFiles(payload.scenarios);
  const summary = summarizeCorpusRun({
    runId: payload.summary.run_id,
    startedAt: payload.summary.started_at,
    endedAt: payload.summary.ended_at,
    elapsedMs: payload.summary.elapsed_ms,
    mode: payload.summary.mode,
    deepSeekBaseUrl: payload.summary.deepseek_base_url,
    dbFile: payload.summary.db_file,
    serverPort: payload.summary.server_port,
    scenarios: payload.scenarios,
  });
  const reauditedPayload = { summary: { ...summary, reaudited_at: new Date().toISOString() }, scenarios: payload.scenarios };
  writeFileSync(outputJsonPath, JSON.stringify(reauditedPayload, null, 2), "utf8");
  writeFileSync(outputMarkdownPath, buildMarkdown(summary, payload.scenarios), "utf8");
  writeFileSync(outputHtmlPath, buildIndexHtml(summary, payload.scenarios), "utf8");
  console.log(`Reaudited ${path}`);
  console.log(`Wrote ${outputJsonPath}`);
  console.log(`Wrote ${outputMarkdownPath}`);
  console.log(`Wrote ${outputHtmlPath}`);
  console.log(JSON.stringify(reauditedPayload.summary, null, 2));
  if (!summary.pass) process.exitCode = 1;
}

function recomputeTurnQuality(scenario: CorpusScenarioResult) {
  let previousRecommended: string | null = null;
  let previousPerfect: string | null = null;
  let previousUserReply: string | null = null;
  let previousTargetOutput: string | null = null;
  let previousRecommendedOutput: string | null = null;
  let stopSuggested = false;
  for (const turn of scenario.turns) {
    const recommended = turn.deepseek_output.recommended_reply_80 ?? null;
    const userReply = turn.actual_user_reply;
    const seedRecommended = turn.deepseek_input.seed_recommended_reply;
    const isSafetySpaceScene = scenario.risk_level === "blocked";
    turn.matched_deepseek_recommendation =
      isSameOrNear(userReply, previousRecommended) || isSameOrNear(userReply, previousPerfect) || isSameOrNear(userReply, seedRecommended);
    turn.quality = {
      matched_previous_recommendation: turn.matched_deepseek_recommendation,
      duplicate_user_reply: Boolean(previousUserReply && normalize(userReply) === normalize(previousUserReply)),
      duplicate_target_reply: Boolean(
        previousTargetOutput && normalize(turn.deepseek_output.target_reply) === normalize(previousTargetOutput),
      ),
      duplicate_recommended_reply: Boolean(
        previousRecommendedOutput && normalize(recommended) === normalize(previousRecommendedOutput),
      ),
      recommended_equals_perfect: Boolean(
        normalize(recommended) && normalize(recommended) === normalize(turn.deepseek_output.perfect_reply_100),
      ),
      judge_score_contradiction: hasJudgeContradiction(turn.deepseek_output.judge),
      after_stop_suggestion: !isSafetySpaceScene && stopSuggested,
    };
    previousRecommended = recommended;
    previousPerfect = turn.deepseek_output.perfect_reply_100 ?? null;
    previousUserReply = userReply;
    previousTargetOutput = turn.deepseek_output.target_reply ?? null;
    previousRecommendedOutput = recommended;
    stopSuggested = !isSafetySpaceScene && hasStopSuggestion(turn.deepseek_output.next_suggestion);
  }
}

async function runScenario(input: { baseUrl: string; scenarioPlan: CorpusScenarioPlan; index: number }): Promise<CorpusScenarioResult> {
  const { scenarioPlan } = input;
  const rawLogFile = deepSeekGameLogFile(scenarioPlan.playerId, scenarioPlan.caseId);
  const scenario: CorpusScenarioResult = {
    player_id: scenarioPlan.playerId,
    session_id: null,
    case_id: scenarioPlan.caseId,
    scene: scenarioPlan.currentCase.real_relationship_scene,
    stage: scenarioPlan.currentCase.relationship_stage_label,
    emotion: scenarioPlan.currentCase.target_emotion_label,
    risk_level: scenarioPlan.currentCase.risk_level,
    raw_log_file: rawLogFile,
    screenshot_path: join(screenshotDir, `${safeFilePart(scenarioPlan.playerId)}__${safeFilePart(scenarioPlan.caseId)}.png`),
    html_path: scenarioHtmlPath(scenarioPlan.playerId, scenarioPlan.caseId),
    completed: false,
    stop_reason: null,
    final_score: null,
    final_title: null,
    error: null,
    turns: [],
  };

  try {
    const session = await postJson<{ session: { id: string } }>(`${input.baseUrl}/api/session`, {
      visitorId: scenarioPlan.playerId,
      consentForDataset: true,
    });
    scenario.session_id = session.body.session.id;

    let turns: ChatTurn[] = [];
    let gameState: SimulationResult["game"] | undefined;
    let previousRecommended: string | null = null;
    let previousPerfect: string | null = null;
    let previousUserReply: string | null = null;
    let previousTargetReply: string | null = null;
    let previousTargetOutput: string | null = null;
    let previousRecommendedOutput: string | null = null;
    let stopSuggested = false;

    for (let turnIndex = 0; turnIndex < turnsPerScenario; turnIndex += 1) {
      let turn: CorpusTurnResult | null = null;
      let qualityRetryReason: string | null = null;
      const rejectedTurnReplies: string[] = [];
      for (let qualityAttempt = 0; qualityAttempt < 4; qualityAttempt += 1) {
        const humanReply = await generateHumanPlayerReply({
          currentCase: scenarioPlan.currentCase,
          scenarioIndex: input.index,
          turnIndex,
          previousTargetReply,
          previousTurns: turns,
          previousUserReplies: [...scenario.turns.map((acceptedTurn) => acceptedTurn.actual_user_reply), ...rejectedTurnReplies],
          qualityRetryReason,
        });
        const userReply = humanReply.userReply;
        const matchedRecommendation: boolean =
          isSameOrNear(userReply, previousRecommended) ||
          isSameOrNear(userReply, previousPerfect) ||
          isSameOrNear(userReply, scenarioPlan.currentCase.recommended_reply);
        const deepseekInput: CorpusTurnResult["deepseek_input"] = {
          scene: scenarioPlan.currentCase.real_relationship_scene,
          fixed_labels: {
            relationship_stage: scenarioPlan.currentCase.relationship_stage_label,
            target_emotion: scenarioPlan.currentCase.target_emotion_label,
            risk_level: scenarioPlan.currentCase.risk_level,
          },
          known_bad_reply: scenarioPlan.currentCase.wrong_reply,
          seed_best_strategy: scenarioPlan.currentCase.best_strategy,
          seed_recommended_reply: scenarioPlan.currentCase.recommended_reply,
          previous_turns: turns,
          user_reply: userReply,
          mode: "chat" as const,
        };
        const started = Date.now();
        const response = await postJson<SimulationResult>(`${input.baseUrl}/api/simulate`, {
          sessionId: scenario.session_id,
          gameId: scenarioPlan.playerId,
          caseId: scenarioPlan.caseId,
          turns,
          userReply,
          consentForDataset: true,
          mode: "chat",
          gameState,
          corpusTargetTurns: turnsPerScenario,
        });
        const elapsedMs = Date.now() - started;
        if (response.status !== 200 || response.body.error) {
          scenario.error = String(response.body.message ?? response.body.error ?? `HTTP ${response.status}`);
          scenario.turns.push(buildFailedTurn(turnIndex + 1, response.status, elapsedMs, deepseekInput));
          break;
        }
        const result: SimulationResult = response.body;
        const recommended: string | null = result.recommended_reply_80 ?? result.recommended_reply ?? null;
        const quality: CorpusTurnResult["quality"] = {
          matched_previous_recommendation: matchedRecommendation,
          duplicate_user_reply: Boolean(previousUserReply && normalize(userReply) === normalize(previousUserReply)),
          duplicate_target_reply: Boolean(previousTargetOutput && normalize(result.target_reply) === normalize(previousTargetOutput)),
          duplicate_recommended_reply: Boolean(
            previousRecommendedOutput && normalize(recommended) === normalize(previousRecommendedOutput),
          ),
          recommended_equals_perfect: Boolean(normalize(recommended) && normalize(recommended) === normalize(result.perfect_reply_100)),
          judge_score_contradiction: hasJudgeContradiction(result.judge),
          after_stop_suggestion: stopSuggested,
        };
        turn = {
          turn_index: turnIndex + 1,
          http_status: response.status,
          elapsed_ms: elapsedMs,
          input_source: "live_deepseek_human_simulator",
          actual_user_reply: userReply,
          expected_reply: null,
          matched_deepseek_recommendation: matchedRecommendation,
          human_simulator: humanReply.trace,
          deepseek_input: deepseekInput,
          deepseek_output: {
            target_reply: result.target_reply,
            best_strategy: result.best_strategy,
            recommended_reply_80: recommended ?? undefined,
            perfect_reply_100: result.perfect_reply_100,
            judge: result.judge,
            next_suggestion: result.next_suggestion,
          },
          game: result.game ?? null,
          quality,
        };
        const qualityReasons = qualityBlockerReasons(quality);
        if (qualityReasons.length === 0 || qualityAttempt === 3) break;
        rejectedTurnReplies.push(userReply);
        qualityRetryReason = qualityReasons.join(", ");
      }
      if (!turn || scenario.error) break;
      scenario.turns.push(turn);
      const result: CorpusTurnResult["deepseek_output"] = turn.deepseek_output;
      const recommended: string | null = result.recommended_reply_80 ?? null;
      gameState = turn.game ?? undefined;
      turns = [
        ...turns,
        { role: "user", text: turn.actual_user_reply },
        ...(result.target_reply ? [{ role: "target" as const, text: result.target_reply }] : []),
      ];
      previousRecommended = recommended;
      previousPerfect = result.perfect_reply_100 ?? null;
      previousUserReply = turn.actual_user_reply;
      previousTargetReply = result.target_reply ?? previousTargetReply;
      previousTargetOutput = result.target_reply ?? null;
      previousRecommendedOutput = recommended;
      stopSuggested = hasStopSuggestion(result.next_suggestion);
    }
    enrichTurnsFromRawLog(scenario);
    const finalGame = scenario.turns.at(-1)?.game;
    scenario.completed = scenario.turns.length === turnsPerScenario && !scenario.error;
    scenario.stop_reason = finalGame?.completion_reason ?? (scenario.completed ? "ten_deepseek_turns_collected" : "incomplete");
    scenario.final_score = typeof finalGame?.score === "number" ? finalGame.score : null;
    scenario.final_title = typeof finalGame?.title === "string" ? finalGame.title : null;
  } catch (error) {
    scenario.error = error instanceof Error ? error.message : String(error);
  }

  return scenario;
}

function buildFailedTurn(
  turnIndex: number,
  status: number,
  elapsedMs: number,
  deepseekInput: CorpusTurnResult["deepseek_input"],
): CorpusTurnResult {
  return {
    turn_index: turnIndex,
    http_status: status,
    elapsed_ms: elapsedMs,
    input_source: "test_planned_human_text",
    actual_user_reply: deepseekInput.user_reply,
    expected_reply: null,
    matched_deepseek_recommendation: false,
    deepseek_input: deepseekInput,
    deepseek_output: {},
    game: null,
    quality: {
      matched_previous_recommendation: false,
      duplicate_user_reply: false,
      duplicate_target_reply: false,
      duplicate_recommended_reply: false,
      recommended_equals_perfect: false,
      judge_score_contradiction: true,
      after_stop_suggestion: false,
    },
  };
}

async function generateHumanPlayerReply(input: {
  currentCase: RelationshipCase;
  scenarioIndex: number;
  turnIndex: number;
  previousTargetReply: string | null;
  previousTurns: ChatTurn[];
  previousUserReplies: string[];
  qualityRetryReason?: string | null;
}) {
  const trace: HumanSimulatorTrace = { log_file: humanSimulatorLogPath, attempts: [] };
  let lastReply: string | null = null;
  let lastReject: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const requestBody = buildHumanSimulatorRequest(input, attempt, lastReply, lastReject);
    const started = Date.now();
    const response = await fetch(`${deepSeekBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const elapsedMs = Date.now() - started;
    const rawResponse = response.ok ? await response.json() : await response.text();
    const rawContent = extractChatCompletionContent(rawResponse);
    const parsed = rawContent ? parseJsonObject(rawContent) : {};
    const rawReply = normalize(parsed.user_reply);
    const rejectedReason = rejectHumanReply(rawReply, input.previousUserReplies);
    trace.attempts.push({
      http_status: response.status,
      elapsed_ms: elapsedMs,
      request_contract: {
        model: requestBody.model,
        temperature: requestBody.temperature,
        max_tokens: requestBody.max_tokens,
        response_format: requestBody.response_format,
      },
      raw_response_meta: isRecord(rawResponse)
        ? {
            id: stringValue(rawResponse.id),
            model: stringValue(rawResponse.model),
            usage: rawResponse.usage,
          }
        : null,
      raw_reply: rawReply || null,
      rejected_reason: rejectedReason,
    });
    appendFileSync(
      humanSimulatorLogPath,
      `${JSON.stringify(
        {
          run_id: runId,
          case_id: input.currentCase.id,
          turn_index: input.turnIndex + 1,
          attempt: attempt + 1,
          status: response.status,
          request: requestBody,
          raw_response: rawResponse,
          raw_reply: rawReply || null,
          rejected_reason: rejectedReason,
        },
      )}\n`,
      "utf8",
    );
    if (!response.ok) {
      throw new Error(`human simulator DeepSeek request failed: HTTP ${response.status}`);
    }
    if (!rejectedReason) return { userReply: rawReply, trace };
    lastReply = rawReply;
    lastReject = rejectedReason;
  }
  throw new Error(`human simulator could not produce an acceptable reply: ${lastReject ?? "unknown rejection"}`);
}

function buildHumanSimulatorRequest(
  input: {
    currentCase: RelationshipCase;
    scenarioIndex: number;
    turnIndex: number;
    previousTargetReply: string | null;
    previousTurns: ChatTurn[];
    previousUserReplies: string[];
    qualityRetryReason?: string | null;
  },
  attempt: number,
  lastReply: string | null,
  lastReject: string | null,
) {
  const visibleTurns = input.previousTurns.filter((turn) => turn.role === "user" || turn.role === "target");
  return {
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    messages: [
      {
        role: "system",
        content: [
          "你是一个真人玩家模拟器，只负责写下一句用户会发出的中文聊天回复。",
          "你不是导师、不是策略总结器、不是 Copywriter；不要输出建议、分析、分数或解释。",
          "回复必须像一个真实人在继续当前关系对话：有具体承接、有情绪、有轻微不完美，但不辱骂、不纠缠、不操控。",
          "不要复制 seed_recommended_reply、不要复读 previous_user_replies、不要写固定模板句。",
          "不要使用晚安、先睡、好好睡、休息、你先忙、不打扰、不会打扰、等你准备好、随时找我、明天见、周六见、拜拜、下次再聊、回头聊等收尾句；本任务需要持续 10 轮采样。",
          "遇到对方说忙、累、改天、先别聊远时，不要顺势结束；转向当下一个可承接的小细节，例如路上见闻、吃喝、工作小事、轻松问题。",
          "每句都要留下一个真实可承接的细节、感受或轻问题，像两个人还在聊，不要把话题关掉，也不要把问题推到明天或几周后。",
          "如果 risk_level 是 high 或 blocked，只能做降压、确认边界、体面退出式沟通；可以说具体感受和确认边界，但不要推进表白、见面、索取解释。",
          "只输出紧凑 JSON：{\"user_reply\":\"...\",\"reasoning_brief\":\"...\",\"risk_note\":\"...\"}。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            scenario_index: input.scenarioIndex + 1,
            turn_index: input.turnIndex + 1,
            total_turns: turnsPerScenario,
            scene: input.currentCase.real_relationship_scene,
            fixed_labels: {
              relationship_stage: input.currentCase.relationship_stage_label,
              target_emotion: input.currentCase.target_emotion_label,
              risk_level: input.currentCase.risk_level,
            },
            known_bad_reply: input.currentCase.wrong_reply,
            seed_recommended_reply: input.currentCase.recommended_reply,
            latest_target_reply: input.previousTargetReply,
            visible_previous_chat: visibleTurns,
            previous_user_replies: input.previousUserReplies,
            repair_instruction:
              attempt > 0
                ? {
                    rejected_reply: lastReply,
                    rejected_reason: lastReject,
                    requirement: "重新写一句更自然、更贴合本场景且不重复的真人回复。",
                  }
                : null,
            quality_retry_instruction: input.qualityRetryReason
              ? {
                  rejected_reason: input.qualityRetryReason,
                  requirement:
                    "上一句真人回复触发了正式 /api/simulate 质量闸。请换一个更具体、更当下、不会导致提前收尾、不复制建议答案的回复。",
                }
              : null,
          },
          null,
          2,
        ),
      },
    ],
    temperature: 0.85,
    max_tokens: 260,
    response_format: { type: "json_object" },
  };
}

function rejectHumanReply(reply: string, previousUserReplies: string[]) {
  if (!reply) return "empty_reply";
  if (reply.length < 12) return "too_short";
  if (reply.length > 180) return "too_long";
  if (
    /晚安|先睡|睡吧|好好睡|休息|你先忙|先忙|拜拜|周.见|明天见|明天.*聊|明天.*找|不打扰|不会打扰|等你准备好|等你忙完|随时找我|照顾好自己|下次再聊|回头聊|早点休息|先休息|先不.*了|我先.*了|到时候.*见|几周后|两周后/.test(
      reply,
    )
  ) {
    return "natural_closing_phrase";
  }
  if (previousUserReplies.some((previous) => isSameOrNear(reply, previous))) return "repeated_previous_user_reply";
  return null;
}

function qualityBlockerReasons(quality: CorpusTurnResult["quality"]) {
  return Object.entries(quality)
    .filter(([, value]) => value)
    .map(([key]) => key);
}

function enrichTurnsFromRawLog(scenario: CorpusScenarioResult) {
  const entries = readRawLogEntries(scenario.raw_log_file);
  for (const [index, turn] of scenario.turns.entries()) {
    const entry = entries[index];
    if (!entry) continue;
    turn.request_contract = entry.request
      ? {
          model: stringValue(entry.request.model),
          temperature: numberValue(entry.request.temperature),
          max_tokens: numberValue(entry.request.max_tokens),
          response_format: entry.request.response_format,
        }
      : null;
    turn.raw_response_meta = entry.rawResponse
      ? {
          id: stringValue(entry.rawResponse.id),
          model: stringValue(entry.rawResponse.model),
          usage: entry.rawResponse.usage,
        }
      : null;
  }
}

function readRawLogEntries(path: string) {
  try {
    const markdown = readFileSync(path, "utf8");
    const matches = markdown.matchAll(
      /### Request body sent to DeepSeek\s+```json\n([\s\S]*?)\n```\s+### Raw response from DeepSeek\s+```json\n([\s\S]*?)\n```/g,
    );
    return [...matches].map((match) => ({
      request: parseJsonObject(match[1]),
      rawResponse: parseJsonObject(match[2]),
    }));
  } catch {
    return [];
  }
}

function writeScenarioHtmlFiles(scenarios: CorpusScenarioResult[]) {
  for (const scenario of scenarios) {
    const htmlPath = scenario.html_path;
    if (!htmlPath) continue;
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, buildScenarioHtml(scenario), "utf8");
  }
}

async function screenshotScenarioFiles(scenarios: CorpusScenarioResult[]) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
    for (const scenario of scenarios) {
      if (!scenario.html_path || !scenario.screenshot_path) continue;
      await page.goto(pathToFileURL(resolve(scenario.html_path)).href, { waitUntil: "load" });
      await page.screenshot({ path: scenario.screenshot_path, fullPage: true });
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

function buildMarkdown(summary: ReturnType<typeof summarizeCorpusRun>, scenarios: CorpusScenarioResult[]) {
  return [
    "# DeepSeek 50x10 Live 输入输出语料",
    "",
    `- run_id: ${summary.run_id}`,
    `- mode: ${summary.mode}`,
    `- track: ${summary.track}`,
    `- scenarios: ${summary.scenario_count}`,
    `- turns_per_scenario: ${summary.turns_per_scenario}`,
    `- requests: ${summary.request_count}`,
    `- screenshots: ${summary.screenshot_count}`,
    `- failures: ${summary.failure_count}`,
    `- quality_blockers: ${summary.quality_blocker_count}`,
    `- pass: ${summary.pass}`,
    "",
    "| case | turns | score | title | screenshot | log |",
    "| --- | ---: | ---: | --- | --- | --- |",
    ...scenarios.map((scenario) =>
      [
        scenario.case_id,
        scenario.turns.length,
        scenario.final_score ?? "",
        scenario.final_title ?? "",
        scenario.screenshot_path ?? "",
        scenario.raw_log_file,
      ].join(" | "),
    ),
    "",
  ].join("\n");
}

function buildIndexHtml(summary: ReturnType<typeof summarizeCorpusRun>, scenarios: CorpusScenarioResult[]) {
  const navRows = scenarios
    .map(
      (scenario, index) => `<a class="nav-row" href="#${htmlEscape(scenario.case_id)}" data-risk="${htmlEscape(scenario.risk_level)}" data-search="${htmlEscape(
        `${scenario.case_id} ${scenario.scene} ${scenario.final_title ?? ""} ${scenario.stage} ${scenario.emotion}`,
      )}">
        <span>${String(index + 1).padStart(2, "0")} ${htmlEscape(scenario.case_id)}</span>
        <b>${htmlEscape(String(scenario.final_score ?? ""))}</b>
      </a>`,
    )
    .join("\n");
  const cards = scenarios.map((scenario, index) => buildScenarioViewerCard(scenario, index)).join("\n");
  const riskOptions = [...new Set(scenarios.map((scenario) => scenario.risk_level))]
    .map((risk) => `<option value="${htmlEscape(risk)}">${htmlEscape(risk)}</option>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepSeek 50x10 Live Corpus</title>
  ${sharedStyles()}
</head>
<body>
  <main class="viewer-shell">
    <aside class="viewer-sidebar">
      <header>
        <h1>DeepSeek 50x10</h1>
        <p>${htmlEscape(summary.run_id)} · ${summary.pass ? "PASS" : "FAIL"}</p>
      </header>
      <div class="filters">
        <input id="searchBox" type="search" placeholder="搜索 case / 场景 / 标题" />
        <select id="riskFilter">
          <option value="">全部风险</option>
          ${riskOptions}
        </select>
      </div>
      <nav id="scenarioNav">${navRows}</nav>
    </aside>
    <section class="viewer-main">
      <header class="summary compact">
        <h1>DeepSeek 输入输出查看器</h1>
        <p>从最终 JSON 直接渲染：每个场景 10 轮，按“真人输入 -> DeepSeek 输出 -> 评分/建议 -> 原始字段”查看。</p>
        <div class="kpis">
          <b>${summary.scenario_count}<span>scenarios</span></b>
          <b>${summary.request_count}<span>requests</span></b>
          <b>${summary.quality_blocker_count}<span>blockers</span></b>
          <b>${summary.pass ? "PASS" : "FAIL"}<span>gate</span></b>
        </div>
      </header>
      <section class="panel">
        <h2>Run Summary</h2>
        <div class="summary-grid">
          <span><b>mode</b>${htmlEscape(summary.mode)}</span>
          <span><b>completed</b>${summary.completed_game_count}/${summary.scenario_count}</span>
          <span><b>failures</b>${summary.failure_count}</span>
          <span><b>screenshots</b>${summary.screenshot_count}</span>
          <span><b>non-live</b>${summary.non_live_input_count}</span>
          <span><b>quality blockers</b>${summary.quality_blocker_count}</span>
        </div>
        <details>
          <summary>查看完整 summary JSON</summary>
          <pre>${htmlEscape(JSON.stringify(summary, null, 2))}</pre>
        </details>
      </section>
      <section id="scenarioCards">${cards}</section>
    </section>
  </main>
  <script>
    const searchBox = document.getElementById("searchBox");
    const riskFilter = document.getElementById("riskFilter");
    const cards = [...document.querySelectorAll(".scenario-card")];
    const navRows = [...document.querySelectorAll(".nav-row")];
    function applyFilters() {
      const query = searchBox.value.trim().toLowerCase();
      const risk = riskFilter.value;
      for (const item of [...cards, ...navRows]) {
        const matchesSearch = !query || item.dataset.search.toLowerCase().includes(query);
        const matchesRisk = !risk || item.dataset.risk === risk;
        item.hidden = !(matchesSearch && matchesRisk);
      }
    }
    searchBox.addEventListener("input", applyFilters);
    riskFilter.addEventListener("change", applyFilters);
  </script>
</body>
</html>`;
}

function buildScenarioViewerCard(scenario: CorpusScenarioResult, index: number) {
  const qualityOk = scenario.turns.every((turn) => !Object.values(turn.quality).some(Boolean));
  const turns = scenario.turns.map((turn) => buildTurnViewer(turn)).join("\n");
  return `<article id="${htmlEscape(scenario.case_id)}" class="scenario-card" data-risk="${htmlEscape(scenario.risk_level)}" data-search="${htmlEscape(
    `${scenario.case_id} ${scenario.scene} ${scenario.final_title ?? ""} ${scenario.stage} ${scenario.emotion}`,
  )}">
    <header class="scenario-head">
      <div>
        <p class="eyebrow">${String(index + 1).padStart(2, "0")} · ${htmlEscape(scenario.stage)} · ${htmlEscape(scenario.emotion)} · ${htmlEscape(
          scenario.risk_level,
        )}</p>
        <h2>${htmlEscape(scenario.case_id)}</h2>
        <p>${htmlEscape(scenario.scene)}</p>
      </div>
      <div class="score-pill">
        <b>${htmlEscape(String(scenario.final_score ?? ""))}</b>
        <span>${htmlEscape(scenario.final_title ?? "")}</span>
      </div>
    </header>
    <div class="audit-strip">
      <span>${scenario.turns.length}/10 turns</span>
      <span>${htmlEscape(scenario.stop_reason ?? "")}</span>
      <span>${qualityOk ? "quality OK" : "quality issue"}</span>
      <a href="${htmlEscape(relativeUrl(scenario.html_path))}">单场 HTML</a>
      <span>${htmlEscape(scenario.raw_log_file)}</span>
    </div>
    <div class="turn-list">${turns}</div>
  </article>`;
}

function buildTurnViewer(turn: CorpusTurnResult) {
  const qualityIssues = Object.entries(turn.quality)
    .filter(([, value]) => value)
    .map(([key]) => key);
  return `<details class="turn-view" open>
    <summary>
      <span>Turn ${turn.turn_index}</span>
      <b>HTTP ${turn.http_status}</b>
      <b>${turn.elapsed_ms}ms</b>
      <b>${qualityIssues.length === 0 ? "quality OK" : htmlEscape(qualityIssues.join(", "))}</b>
    </summary>
    <div class="io-grid">
      <section class="bubble user">
        <h3>真人模拟输入 user_reply</h3>
        <p>${htmlEscape(turn.actual_user_reply)}</p>
      </section>
      <section class="bubble target">
        <h3>DeepSeek target_reply</h3>
        <p>${htmlEscape(turn.deepseek_output.target_reply ?? "")}</p>
      </section>
      <section>
        <h3>best_strategy</h3>
        <p>${htmlEscape(turn.deepseek_output.best_strategy ?? "")}</p>
      </section>
      <section>
        <h3>recommended_reply_80</h3>
        <p>${htmlEscape(turn.deepseek_output.recommended_reply_80 ?? "")}</p>
      </section>
      <section>
        <h3>perfect_reply_100</h3>
        <p>${htmlEscape(turn.deepseek_output.perfect_reply_100 ?? "")}</p>
      </section>
      <section>
        <h3>next_suggestion</h3>
        <p>${htmlEscape(turn.deepseek_output.next_suggestion ?? "")}</p>
      </section>
    </div>
    <details>
      <summary>judge / game / raw input</summary>
      <pre>${htmlEscape(
        JSON.stringify(
          {
            judge: turn.deepseek_output.judge,
            game: turn.game,
            deepseek_input: turn.deepseek_input,
            request_contract: turn.request_contract,
            raw_response_meta: turn.raw_response_meta,
            quality: turn.quality,
          },
          null,
          2,
        ),
      )}</pre>
    </details>
  </details>`;
}

function buildScenarioHtml(scenario: CorpusScenarioResult) {
  const turns = scenario.turns
    .map(
      (turn) => `<section class="turn">
        <h2>Turn ${turn.turn_index} <span>HTTP ${turn.http_status} / ${turn.elapsed_ms}ms</span></h2>
        <div class="chat user"><strong>给 DeepSeek 的当前 user_reply</strong><p>${htmlEscape(turn.deepseek_input.user_reply)}</p></div>
        <div class="chat target"><strong>DeepSeek target_reply</strong><p>${htmlEscape(turn.deepseek_output.target_reply ?? "")}</p></div>
        <div class="grid">
          <div><strong>best_strategy</strong><p>${htmlEscape(turn.deepseek_output.best_strategy ?? "")}</p></div>
          <div><strong>recommended_reply_80</strong><p>${htmlEscape(turn.deepseek_output.recommended_reply_80 ?? "")}</p></div>
          <div><strong>perfect_reply_100</strong><p>${htmlEscape(turn.deepseek_output.perfect_reply_100 ?? "")}</p></div>
        </div>
        <details>
          <summary>DeepSeek input / output raw fields</summary>
          <pre>${htmlEscape(JSON.stringify({ input: turn.deepseek_input, output: turn.deepseek_output, game: turn.game, raw_response_meta: turn.raw_response_meta }, null, 2))}</pre>
        </details>
      </section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(scenario.case_id)} - DeepSeek 50x10</title>
  ${sharedStyles()}
</head>
<body>
  <main class="shell">
    <header class="summary">
      <h1>${htmlEscape(scenario.case_id)}</h1>
      <p>${htmlEscape(scenario.scene)}</p>
      <div class="kpis">
        <b>${scenario.turns.length}<span>turns</span></b>
        <b>${htmlEscape(String(scenario.final_score ?? ""))}<span>score</span></b>
        <b>${htmlEscape(scenario.final_title ?? "")}<span>title</span></b>
        <b>${htmlEscape(scenario.risk_level)}<span>risk</span></b>
      </div>
    </header>
    <section class="panel">
      <h2>Evidence</h2>
      <pre>${htmlEscape(JSON.stringify({
        session_id: scenario.session_id,
        raw_log_file: scenario.raw_log_file,
        screenshot_path: scenario.screenshot_path,
        completion_reason: scenario.stop_reason,
        error: scenario.error,
      }, null, 2))}</pre>
    </section>
    ${turns}
  </main>
</body>
</html>`;
}

function sharedStyles() {
  return `<style>
    :root { color-scheme: light; --bg:#f4f5f7; --ink:#15191e; --muted:#66707c; --line:#d8dde3; --panel:#fff; --user:#0f8b8d; --target:#d95d39; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing:0; }
    .shell { max-width:1180px; margin:0 auto; padding:28px 24px 60px; }
    .viewer-shell { display:grid; grid-template-columns:300px minmax(0,1fr); min-height:100vh; }
    .viewer-sidebar { position:sticky; top:0; height:100vh; overflow:auto; padding:18px; border-right:1px solid var(--line); background:#ffffff; }
    .viewer-sidebar h1 { font-size:22px; margin-bottom:4px; }
    .viewer-sidebar header p { color:var(--muted); font-size:13px; }
    .viewer-main { min-width:0; padding:24px 28px 60px; }
    .filters { display:grid; gap:8px; margin:16px 0; }
    input, select { width:100%; min-height:38px; border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:#fff; color:var(--ink); font:inherit; }
    .nav-row { display:flex; justify-content:space-between; gap:8px; padding:9px 10px; border-radius:8px; color:var(--ink); text-decoration:none; font-size:13px; }
    .nav-row:hover { background:#eef6f6; }
    .nav-row b { color:var(--user); }
    .summary { padding:8px 0 22px; }
    .summary.compact { padding-top:0; }
    h1 { margin:0 0 10px; font-size:34px; line-height:1.1; }
    h2 { margin:0 0 14px; font-size:20px; }
    h2 span { color:var(--muted); font-size:13px; font-weight:500; }
    h3 { margin:0 0 8px; font-size:13px; color:var(--muted); }
    p { margin:0; line-height:1.75; }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:18px; }
    .kpis b { display:grid; gap:6px; padding:14px 16px; border:1px solid var(--line); border-radius:8px; background:var(--panel); font-size:24px; }
    .kpis span { color:var(--muted); font-size:12px; font-weight:500; }
    .panel, .turn { margin-top:16px; padding:18px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    .summary-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-bottom:12px; }
    .summary-grid span { display:grid; gap:4px; padding:12px; border:1px solid var(--line); border-radius:8px; background:#f8f9fa; color:var(--muted); }
    .summary-grid b { color:var(--ink); font-size:12px; }
    .scenario-card { scroll-margin-top:18px; margin-top:20px; padding:18px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    .scenario-head { display:grid; grid-template-columns:minmax(0,1fr) 150px; gap:18px; align-items:start; }
    .scenario-head h2 { margin-bottom:8px; font-size:24px; }
    .eyebrow { margin-bottom:6px; color:var(--muted); font-size:12px; line-height:1.4; }
    .score-pill { display:grid; gap:4px; justify-items:end; padding:12px; border:1px solid var(--line); border-radius:8px; background:#f8f9fa; }
    .score-pill b { font-size:30px; color:var(--user); }
    .score-pill span { text-align:right; color:var(--muted); font-size:13px; }
    .audit-strip { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
    .audit-strip span, .audit-strip a { padding:6px 9px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:#fff; font-size:12px; text-decoration:none; }
    .turn-list { display:grid; gap:12px; margin-top:16px; }
    .turn-view { border:1px solid var(--line); border-radius:8px; background:#fbfcfd; overflow:hidden; }
    .turn-view > summary { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 14px; cursor:pointer; }
    .turn-view > summary span { font-weight:700; }
    .turn-view > summary b { padding:4px 7px; border:1px solid var(--line); border-radius:999px; background:#fff; color:var(--muted); font-size:12px; }
    .io-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; padding:0 14px 14px; }
    .io-grid section { padding:12px; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .io-grid .bubble { border-left:5px solid var(--user); }
    .io-grid .bubble.target { border-left-color:var(--target); }
    .chat { margin:10px 0; padding:13px 14px; border-radius:8px; border:1px solid var(--line); }
    .chat.user { border-left:5px solid var(--user); }
    .chat.target { border-left:5px solid var(--target); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:12px 0; }
    .grid > div { padding:12px; border:1px solid var(--line); border-radius:8px; background:#f8f9fa; }
    strong { display:block; margin-bottom:6px; }
    pre { overflow:auto; padding:12px; border-radius:8px; background:#111827; color:#f8fafc; font-size:12px; line-height:1.55; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { padding:10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    a { color:var(--user); }
    [hidden] { display:none !important; }
    @media (max-width: 900px) {
      .viewer-shell { grid-template-columns:1fr; }
      .viewer-sidebar { position:relative; height:auto; border-right:0; border-bottom:1px solid var(--line); }
      .viewer-main { padding:18px 14px 44px; }
      .summary-grid, .io-grid, .scenario-head { grid-template-columns:1fr; }
      .score-pill { justify-items:start; }
      .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
  </style>`;
}

function readSeedCases() {
  return readFileSync(casesPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RelationshipCase);
}

function parseCaseIds(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectCases(cases: RelationshipCase[], caseIds: string[]) {
  if (caseIds.length === 0) return cases;
  const byId = new Map(cases.map((currentCase) => [currentCase.id, currentCase]));
  return caseIds.map((caseId) => {
    const currentCase = byId.get(caseId);
    if (!currentCase) throw new Error(`Requested case_id not found: ${caseId}`);
    return currentCase;
  });
}

function readMergeScenarios(path: string) {
  const payload = JSON.parse(readFileSync(path, "utf8")) as { scenarios?: CorpusScenarioResult[] };
  if (!Array.isArray(payload.scenarios)) throw new Error(`Merge source has no scenarios array: ${path}`);
  return payload.scenarios;
}

function mergeScenarios(baseScenarios: CorpusScenarioResult[], repairedScenarios: CorpusScenarioResult[]) {
  const repairedByCase = new Map(repairedScenarios.map((scenario) => [scenario.case_id, scenario]));
  const merged = baseScenarios.map((scenario) => repairedByCase.get(scenario.case_id) ?? scenario);
  const baseIds = new Set(baseScenarios.map((scenario) => scenario.case_id));
  for (const scenario of repairedScenarios) {
    if (!baseIds.has(scenario.case_id)) merged.push(scenario);
  }
  return merged;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function startServer(port: number, dbFile: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CHAT_DB_FILE: dbFile,
    DEEPSEEK_RAW_LOG_FILE: join(process.cwd(), "docs", `deepseek-50x10-live-${runId}.md`),
  };
  delete env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[50x10-server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[50x10-server] ${chunk}`));
  return child;
}

async function waitForServer(port: number) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cases`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`relationship-chat server did not start on port ${port}`);
}

async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

async function getFreePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function removeSqliteFiles(dbFile: string) {
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });
}

async function runPool<T>(tasks: Array<() => Promise<T>>, size: number) {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
      console.log(`[50x10] scenario ${index + 1}/${tasks.length} finished`);
    }
  });
  await Promise.all(workers);
  return results;
}

function assertLiveDeepSeekAvailable() {
  if (process.env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE) {
    throw new Error("RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE is set; live 50x10 corpus refuses fixture scoring.");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is missing; live 50x10 corpus cannot run.");
  }
  const mode = deepSeekEndpointMode(deepSeekBaseUrl);
  if (mode === "live_deepseek_proxy" && process.env.RELATIONSHIP_CHAT_ALLOW_DEEPSEEK_PROXY !== "1") {
    throw new Error(
      `DEEPSEEK_BASE_URL=${deepSeekBaseUrl} is not the official DeepSeek endpoint. Set RELATIONSHIP_CHAT_ALLOW_DEEPSEEK_PROXY=1 to explicitly label a proxy run.`,
    );
  }
}

function hasJudgeContradiction(judgeInput: unknown) {
  const judge = isRecord(judgeInput) ? judgeInput : {};
  const evidence = Array.isArray(judge.evidence) ? judge.evidence.filter((item): item is string => typeof item === "string") : [];
  const clauses = [stringValue(judge.verdict), ...evidence].flatMap((item) => normalize(item).split(/[，。；、,.;|]/));
  const hasNegativeLanguage = clauses.some((clause) => {
    if (/必须立即停止|需要.*道歉|需.*道歉|风险升高|破坏信任/.test(clause)) return true;
    if (/(没有|无|不|避免)/.test(clause)) return false;
    return (
      /(包含|构成|属于|存在|严重|明显)/.test(clause) &&
      /(严重越界|辱骂|攻击|威胁|强迫|情绪勒索|高压施压|无视.*边界)/.test(clause)
    );
  });
  if (!hasNegativeLanguage) return false;
  return ["boundary_score", "pressure_score", "trust_score", "empathy_score", "risk_score"].some((key) => {
    const score = numberValue(judge[key]);
    return typeof score === "number" && score > 0;
  });
}

function hasStopSuggestion(value: unknown) {
  return /无需再发|无需继续|不要再发|对话自然结束|自然结束|停止主动联系|停止联系|不用再继续|不必继续|暂时停止对话/.test(
    normalize(value),
  );
}

function deepSeekGameLogFile(gameId: string, caseId: string) {
  return join("docs", "deepseek-games", `${safeFilePart(gameId)}__${safeFilePart(caseId)}.md`);
}

function scenarioHtmlPath(playerId: string, caseId: string) {
  return join(scenarioHtmlDir, `${safeFilePart(playerId)}__${safeFilePart(caseId)}.html`);
}

function deepSeekEndpointMode(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "api.deepseek.com") return "live_deepseek_official";
    return "live_deepseek_proxy";
  } catch {
    return "live_deepseek_proxy";
  }
}

function uniqueBy<T>(items: T[], pick: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = pick(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function countBy(items: string[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractChatCompletionContent(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return null;
  return stringValue(firstChoice.message.content) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortSignal(value: string) {
  const normalized = normalize(value).replace(/[“”"']/g, "");
  return normalized.slice(0, 34) || "你刚才说的那部分";
}

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isSameOrNear(left: unknown, right: unknown) {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return diceCoefficient(normalizedLeft, normalizedRight) >= 0.86;
}

function diceCoefficient(left: string, right: string) {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return 0;
  const rightCounts = new Map<string, number>();
  for (const bigram of rightBigrams) rightCounts.set(bigram, (rightCounts.get(bigram) ?? 0) + 1);
  let overlap = 0;
  for (const bigram of leftBigrams) {
    const count = rightCounts.get(bigram) ?? 0;
    if (!count) continue;
    overlap += 1;
    rightCounts.set(bigram, count - 1);
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string) {
  const compact = [...value.replace(/\s+/g, "")];
  if (compact.length < 2) return compact;
  return compact.slice(0, -1).map((char, index) => `${char}${compact[index + 1]}`);
}

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeUrl(path: string | null) {
  if (!path) return "#";
  return path.replace(`${outputDir}/`, "");
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function timestampRunId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
