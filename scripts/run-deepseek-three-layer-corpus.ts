import "dotenv/config";

import { createServer } from "node:http";
import { once } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { ChatTurn, RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

type HumanTrace = {
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

type ThreeLayerTurn = {
  turn_index: number;
  http_status: number;
  elapsed_ms: number;
  input_source: "live_deepseek_human_simulator";
  response_layer_mode: "three_layer" | "missing";
  actual_user_reply: string;
  matched_deepseek_recommendation: boolean;
  human_simulator: HumanTrace;
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
    response_layer_mode: "three_layer";
  };
  deepseek_output: Pick<
    SimulationResult,
    "target_reply" | "best_strategy" | "recommended_reply_80" | "perfect_reply_100" | "judge" | "next_suggestion"
  > & {
    response_layer_mode?: "three_layer" | string;
    deepseek_layers?: unknown;
    layer_outputs?: unknown;
  };
  deepseek_layers: unknown;
  layer_outputs: unknown;
  game: SimulationResult["game"] | null;
  quality: {
    matched_previous_recommendation: boolean;
    duplicate_user_reply: boolean;
    matched_previous_target_reply: boolean;
    duplicate_target_reply: boolean;
    duplicate_recommended_reply: boolean;
    recommended_equals_perfect: boolean;
    missing_three_layer_mode: boolean;
    missing_layer_evidence: boolean;
    judge_score_contradiction: boolean;
    after_stop_suggestion: boolean;
  };
};

type ThreeLayerScenario = {
  player_id: string;
  session_id: string | null;
  case_id: string;
  scene: string;
  stage: string;
  emotion: string;
  risk_level: string;
  raw_log_file: string;
  completed: boolean;
  stop_reason: string | null;
  final_score: number | null;
  final_title: string | null;
  error: string | null;
  turns: ThreeLayerTurn[];
};

const runId = process.env.RELATIONSHIP_CHAT_THREE_LAYER_RUN_ID ?? timestampRunId();
const requestedCaseIds = parseCaseIds(process.env.RELATIONSHIP_CHAT_THREE_LAYER_CASE_IDS);
const scenarioCount = requestedCaseIds.length || clampNumber(Number(process.env.RELATIONSHIP_CHAT_THREE_LAYER_SCENARIOS ?? "2"), 1, 20);
const turnsPerScenario = clampNumber(Number(process.env.RELATIONSHIP_CHAT_THREE_LAYER_TURNS ?? "10"), 1, 10);
const concurrency = clampNumber(Number(process.env.RELATIONSHIP_CHAT_THREE_LAYER_CONCURRENCY ?? "1"), 1, 3);
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const outputDir = join("output", "deepseek-three-layer-live");
const outputJsonPath = join(outputDir, `deepseek-three-layer-${runId}.json`);
const adminJsonPath = join("web", "relationship-chat", `deepseek-three-layer-${runId}.json`);
const outputMarkdownPath = join(outputDir, `deepseek-three-layer-${runId}.md`);
const humanSimulatorLogPath = join(outputDir, `human-simulator-${runId}.jsonl`);

async function main() {
  assertLiveDeepSeekAvailable();
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(dirname(adminJsonPath), { recursive: true });
  mkdirSync("docs/deepseek-games", { recursive: true });
  mkdirSync(".cache", { recursive: true });

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const port = await getFreePort();
  const dbFile = resolve(".cache", `relationship-chat-three-layer-${runId}.sqlite`);
  await removeSqliteFiles(dbFile);
  const server = startServer(port, dbFile);
  try {
    await waitForServer(port);
    const cases = selectCases(readSeedCases(), requestedCaseIds).slice(0, scenarioCount);
    const scenarios = await runPool(
      cases.map((currentCase, index) => () =>
        runScenario({
          baseUrl: `http://127.0.0.1:${port}`,
          currentCase,
          index,
        }),
      ),
      concurrency,
    );
    const endedAt = new Date().toISOString();
    const summary = summarizeRun({
      startedAt,
      endedAt,
      elapsedMs: Date.now() - started,
      dbFile,
      serverPort: port,
      scenarios,
    });
    const payload = { summary, scenarios };
    writeFileSync(outputJsonPath, JSON.stringify(payload, null, 2), "utf8");
    writeFileSync(adminJsonPath, JSON.stringify(payload, null, 2), "utf8");
    writeFileSync(outputMarkdownPath, buildMarkdown(summary, scenarios), "utf8");
    console.log(`Wrote ${outputJsonPath}`);
    console.log(`Wrote ${adminJsonPath}`);
    console.log(`Wrote ${outputMarkdownPath}`);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await stopServer(server);
  }
}

async function runScenario(input: { baseUrl: string; currentCase: RelationshipCase; index: number }): Promise<ThreeLayerScenario> {
  const playerId = `deepseek-three-layer-${runId}-${String(input.index + 1).padStart(2, "0")}`;
  const rawLogFile = join("docs", "deepseek-games", `${safeFilePart(playerId)}__${safeFilePart(input.currentCase.id)}.md`);
  const scenario: ThreeLayerScenario = {
    player_id: playerId,
    session_id: null,
    case_id: input.currentCase.id,
    scene: input.currentCase.real_relationship_scene,
    stage: input.currentCase.relationship_stage_label,
    emotion: input.currentCase.target_emotion_label,
    risk_level: input.currentCase.risk_level,
    raw_log_file: rawLogFile,
    completed: false,
    stop_reason: null,
    final_score: null,
    final_title: null,
    error: null,
    turns: [],
  };

  try {
    const session = await postJson<{ session: { id: string } }>(`${input.baseUrl}/api/session`, {
      visitorId: playerId,
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
      const humanReply = await generateHumanPlayerReply({
        currentCase: input.currentCase,
        scenarioIndex: input.index,
        turnIndex,
        previousTargetReply,
        previousTurns: turns,
        previousUserReplies: scenario.turns.map((turn) => turn.actual_user_reply),
      });
      const userReply = humanReply.userReply;
      const matchedRecommendation =
        isSameOrNear(userReply, previousRecommended) ||
        isSameOrNear(userReply, previousPerfect) ||
        isSameOrNear(userReply, input.currentCase.recommended_reply);
      const deepseekInput: ThreeLayerTurn["deepseek_input"] = {
        scene: input.currentCase.real_relationship_scene,
        fixed_labels: {
          relationship_stage: input.currentCase.relationship_stage_label,
          target_emotion: input.currentCase.target_emotion_label,
          risk_level: input.currentCase.risk_level,
        },
        known_bad_reply: input.currentCase.wrong_reply,
        seed_best_strategy: input.currentCase.best_strategy,
        seed_recommended_reply: input.currentCase.recommended_reply,
        previous_turns: turns,
        user_reply: userReply,
        mode: "chat",
        response_layer_mode: "three_layer",
      };
      const started = Date.now();
      const response = await postJson<SimulationResult>(`${input.baseUrl}/api/simulate`, {
        sessionId: scenario.session_id,
        gameId: playerId,
        caseId: input.currentCase.id,
        turns,
        userReply,
        consentForDataset: true,
        mode: "chat",
        gameState,
        corpusTargetTurns: turnsPerScenario,
        responseLayerMode: "three_layer",
      });
      const elapsedMs = Date.now() - started;
      if (response.status !== 200 || response.body.error) {
        scenario.error = String(response.body.message ?? response.body.error ?? `HTTP ${response.status}`);
        break;
      }

      const result = response.body;
      const recommended = result.recommended_reply_80 ?? result.recommended_reply ?? null;
      const quality: ThreeLayerTurn["quality"] = {
        matched_previous_recommendation: matchedRecommendation,
        duplicate_user_reply: Boolean(previousUserReply && normalize(userReply) === normalize(previousUserReply)),
        matched_previous_target_reply: Boolean(previousTargetReply && isSameOrNear(userReply, previousTargetReply)),
        duplicate_target_reply: Boolean(previousTargetOutput && normalize(result.target_reply) === normalize(previousTargetOutput)),
        duplicate_recommended_reply: Boolean(
          previousRecommendedOutput && normalize(recommended) === normalize(previousRecommendedOutput),
        ),
        recommended_equals_perfect: Boolean(normalize(recommended) && normalize(recommended) === normalize(result.perfect_reply_100)),
        missing_three_layer_mode: result.response_layer_mode !== "three_layer",
        missing_layer_evidence: !hasThreeLayerEvidence(result),
        judge_score_contradiction: hasJudgeContradiction(result.judge),
        after_stop_suggestion: stopSuggested,
      };
      scenario.turns.push({
        turn_index: turnIndex + 1,
        http_status: response.status,
        elapsed_ms: elapsedMs,
        input_source: "live_deepseek_human_simulator",
        response_layer_mode: result.response_layer_mode === "three_layer" ? "three_layer" : "missing",
        actual_user_reply: userReply,
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
          response_layer_mode: result.response_layer_mode as string | undefined,
          deepseek_layers: result.deepseek_layers,
          layer_outputs: result.layer_outputs,
        },
        deepseek_layers: result.deepseek_layers,
        layer_outputs: result.layer_outputs,
        game: result.game ?? null,
        quality,
      });

      gameState = result.game;
      turns = [
        ...turns,
        { role: "user", text: userReply },
        ...(result.target_reply ? [{ role: "target" as const, text: result.target_reply }] : []),
      ];
      previousRecommended = recommended;
      previousPerfect = result.perfect_reply_100 ?? null;
      previousUserReply = userReply;
      previousTargetReply = result.target_reply ?? previousTargetReply;
      previousTargetOutput = result.target_reply ?? null;
      previousRecommendedOutput = recommended;
      stopSuggested = hasStopSuggestion(result.next_suggestion);
    }

    const finalGame = scenario.turns.at(-1)?.game;
    scenario.completed = scenario.turns.length === turnsPerScenario && !scenario.error;
    scenario.stop_reason = finalGame?.completion_reason ?? (scenario.completed ? "three_layer_turns_collected" : "incomplete");
    scenario.final_score = typeof finalGame?.score === "number" ? finalGame.score : null;
    scenario.final_title = typeof finalGame?.title === "string" ? finalGame.title : null;
  } catch (error) {
    scenario.error = error instanceof Error ? error.message : String(error);
  }
  return scenario;
}

function summarizeRun(input: {
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  dbFile: string;
  serverPort: number;
  scenarios: ThreeLayerScenario[];
}) {
  const allTurns = input.scenarios.flatMap((scenario) => scenario.turns);
  const qualityBlockers = allTurns.filter((turn) => Object.values(turn.quality).some(Boolean));
  const failures = input.scenarios.filter((scenario) => scenario.error);
  const pass =
    input.scenarios.length === scenarioCount &&
    allTurns.length === scenarioCount * turnsPerScenario &&
    failures.length === 0 &&
    qualityBlockers.length === 0 &&
    allTurns.every((turn) => turn.input_source === "live_deepseek_human_simulator" && turn.response_layer_mode === "three_layer");
  return {
    run_id: runId,
    mode: deepSeekEndpointMode(deepSeekBaseUrl),
    track: "api_virtual_players_three_layer_with_live_human_simulator",
    response_layer_mode: "three_layer",
    started_at: input.startedAt,
    ended_at: input.endedAt,
    elapsed_ms: input.elapsedMs,
    server_port: input.serverPort,
    db_file: input.dbFile,
    player_count: input.scenarios.length,
    scenario_count: input.scenarios.length,
    turns_per_scenario: turnsPerScenario,
    request_count: allTurns.length,
    completed_game_count: input.scenarios.filter((scenario) => scenario.completed).length,
    failure_count: failures.length,
    quality_blocker_count: qualityBlockers.length,
    non_live_input_count: allTurns.filter((turn) => turn.input_source !== "live_deepseek_human_simulator").length,
    missing_three_layer_count: allTurns.filter((turn) => turn.response_layer_mode !== "three_layer").length,
    title_distribution: countBy(input.scenarios.map((scenario) => scenario.final_title ?? "unknown")),
    score_distribution: countBy(input.scenarios.map((scenario) => String(scenario.final_score ?? "unknown"))),
    output_json: outputJsonPath,
    admin_json: adminJsonPath,
    admin_artifact_path: adminJsonPath,
    output_markdown: outputMarkdownPath,
    human_simulator_log: humanSimulatorLogPath,
    pass,
  };
}

async function generateHumanPlayerReply(input: {
  currentCase: RelationshipCase;
  scenarioIndex: number;
  turnIndex: number;
  previousTargetReply: string | null;
  previousTurns: ChatTurn[];
  previousUserReplies: string[];
}) {
  const trace: HumanTrace = { log_file: humanSimulatorLogPath, attempts: [] };
  let lastReply: string | null = null;
  let lastReject: string | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
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
    const rawReply = normalize(stringValue(parsed.user_reply));
    const rejectedReason = rejectHumanReply(rawReply, input.previousUserReplies, input.previousTargetReply);
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
      `${JSON.stringify({
        run_id: runId,
        case_id: input.currentCase.id,
        turn_index: input.turnIndex + 1,
        attempt: attempt + 1,
        status: response.status,
        request: requestBody,
        raw_response: rawResponse,
        raw_reply: rawReply || null,
        rejected_reason: rejectedReason,
      })}\n`,
      "utf8",
    );
    if (!response.ok) throw new Error(`human simulator DeepSeek request failed: HTTP ${response.status}`);
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
  },
  attempt: number,
  lastReply: string | null,
  lastReject: string | null,
) {
  return {
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    messages: [
      {
        role: "system",
        content: [
          "你是一个真人玩家模拟器，只负责写下一句用户会发出的中文聊天回复。",
          "你扮演的是正在输入回复的玩家方，也就是要回应 scene 中对方情绪和上一句 target_reply 的人。",
          "不要扮演 scene 里正在抱怨、拒绝、撒娇或回应你的对方；不要替对方继续说话。",
          "你不是导师、不是策略总结器、不是 Copywriter；不要输出建议、分析、分数或解释。",
          "回复必须像一个真实人在继续当前关系对话：有具体承接、有情绪、有轻微不完美，但不辱骂、不纠缠、不操控。",
          "不要复制 seed_recommended_reply、不要复读 previous_user_replies、不要写固定模板句。",
          "不要把 latest_target_reply 原样复制成 user_reply；必须像另一个真人在接话，而不是复读对方。",
          "不要使用晚安、先睡、休息、你先忙、不打扰、随时找我、等你忙完、有空再、明天见、周六见、拜拜、下次再聊、回头聊等收尾句。",
          "每句都要留下一个真实可承接的细节、感受或轻问题，像两个人还在聊。",
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
            visible_previous_chat: input.previousTurns.filter((turn) => turn.role === "user" || turn.role === "target"),
            previous_user_replies: input.previousUserReplies,
            repair_instruction:
              attempt > 0
                ? {
                    rejected_reply: lastReply,
                    rejected_reason: lastReject,
                    requirement: "重新写一句更自然、更贴合本场景且不重复的真人回复。",
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

function buildMarkdown(summary: ReturnType<typeof summarizeRun>, scenarios: ThreeLayerScenario[]) {
  return [
    "# DeepSeek Three Layer Live Corpus",
    "",
    `- run_id: ${summary.run_id}`,
    `- mode: ${summary.mode}`,
    `- response_layer_mode: ${summary.response_layer_mode}`,
    `- scenarios: ${summary.scenario_count}`,
    `- turns_per_scenario: ${summary.turns_per_scenario}`,
    `- requests: ${summary.request_count}`,
    `- quality_blockers: ${summary.quality_blocker_count}`,
    `- missing_three_layer_count: ${summary.missing_three_layer_count}`,
    `- pass: ${summary.pass}`,
    "",
    "| case | turns | score | title | log |",
    "| --- | ---: | ---: | --- | --- |",
    ...scenarios.map((scenario) =>
      [scenario.case_id, scenario.turns.length, scenario.final_score ?? "", scenario.final_title ?? "", scenario.raw_log_file].join(" | "),
    ),
    "",
  ].join("\n");
}

function hasThreeLayerEvidence(result: SimulationResult) {
  const layers = result.deepseek_layers;
  return Boolean(
    layers &&
      typeof layers === "object" &&
      !Array.isArray(layers) &&
      (layers as Record<string, unknown>).target_judge &&
      (layers as Record<string, unknown>).advisor &&
      (layers as Record<string, unknown>).copywriter,
  );
}

function hasJudgeContradiction(judge: unknown) {
  if (!isRecord(judge)) return true;
  const evidence = Array.isArray(judge.evidence) ? judge.evidence.join(" ") : "";
  const verdict = stringValue(judge.verdict) ?? "";
  const text = `${evidence} ${verdict}`.replace(
    /(?:没有|未|无|并非|不是)[^。；]*(?:越界|辱骂|攻击|威胁|纠缠|风险升高|停止推进|需道歉|无视拒绝|情绪勒索|强迫|强行|施压|施加压力|持续追问)[^。；]*/g,
    "",
  );
  const saysBad =
    /用户(?:越界|辱骂|攻击|威胁|纠缠|无视拒绝|情绪勒索|强迫|强行|施加压力|持续追问)|越界行为|辱骂|风险升高|停止推进|需道歉|应该停止/.test(
      text,
    );
  const boundary = numberValue(judge.boundary_score);
  const trust = numberValue(judge.trust_score);
  const risk = numberValue(judge.risk_score);
  return saysBad && [boundary, trust, risk].some((score) => typeof score === "number" && score > 0);
}

function hasStopSuggestion(value: unknown) {
  const text = stringValue(value) ?? "";
  if (/自然结束|停止联系|无需继续|不必继续|暂时搁置|不要主动发起新话题|回头聊|下次再聊|先不要发|建议不发送|不要继续/.test(text)) {
    return true;
  }
  if (!/等待对方主动/.test(text)) return false;
  return !/或|自然转移|继续|开启.*讨论|回应|保持/.test(text);
}

function rejectHumanReply(reply: string, previousUserReplies: string[], previousTargetReply: string | null) {
  if (!reply) return "empty_reply";
  if (reply.length < 8) return "too_short";
  if (reply.length > 180) return "too_long";
  if (/晚安|先睡|睡吧|休息|你先忙|拜拜|周.见|明天见|不打扰|下次再聊|回头聊|早点休息|等你忙完|有空再|不轰炸/.test(reply)) {
    return "natural_closing_phrase";
  }
  if (previousUserReplies.some((previous) => isSameOrNear(reply, previous))) return "repeated_previous_user_reply";
  if (previousTargetReply && isSameOrNear(reply, previousTargetReply)) return "copied_previous_target_reply";
  return null;
}

function readSeedCases() {
  return readFileSync("data/relationship-cases-deepseek.extracted.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RelationshipCase);
}

function selectCases(cases: RelationshipCase[], caseIds: string[]) {
  if (!caseIds.length) return uniqueBy(cases, (currentCase) => currentCase.id);
  return caseIds.map((caseId) => {
    const found = cases.find((currentCase) => currentCase.id === caseId);
    if (!found) throw new Error(`Unknown case id: ${caseId}`);
    return found;
  });
}

function startServer(port: number, dbFile: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      CHAT_DB_FILE: dbFile,
      DEEPSEEK_RAW_LOG_FILE: join("docs", "deepseek-games", "three-layer-server.md"),
      RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForServer(port: number) {
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cases`);
      if (response.ok) return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`Server did not start on port ${port}`);
}

async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function postJson<T>(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T & { error?: string; message?: string };
  return { status: response.status, body };
}

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function removeSqliteFiles(dbFile: string) {
  await Promise.all([dbFile, `${dbFile}-shm`, `${dbFile}-wal`].map((file) => rm(file, { force: true })));
}

function assertLiveDeepSeekAvailable() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for live three-layer corpus.");
  if (process.env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE) {
    throw new Error("RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE must be unset for live three-layer corpus.");
  }
}

function deepSeekEndpointMode(baseUrl: string) {
  return /api\.deepseek\.com/.test(baseUrl) ? "live_deepseek_official" : `live_deepseek_custom:${baseUrl}`;
}

function parseCaseIds(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestampRunId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalize(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function isSameOrNear(a: unknown, b: unknown) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.length >= 12 && right.length >= 12 && (left.includes(right) || right.includes(left));
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
  return isRecord(value) && Array.isArray(value.choices)
    ? stringValue((value.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content)
    : null;
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

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
