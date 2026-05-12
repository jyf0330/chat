import { readJsonResponse } from "./api.js";
import { chooseRandomCaseIndex, shuffleCases } from "./case-selection.js";

const DEFAULT_CUSTOM_SCENE = [
  "我和暧昧对象连续聊了两周，昨晚我连续发了三条消息追问为什么突然冷淡。对方今天回复：我最近真的有点累，不是不想理你，只是你这样一直问我会很有压力。",
  "我想继续推进关系，但又怕再追问会让对方更想躲开。",
].join("\n");

const GAME_MAX_TURNS = 10;
const PLAYED_CASE_IDS_KEY = "relationship-chat.played-case-ids";
const DATASET_CONSENT_KEY = "relationship-chat.dataset-consent";
const ONBOARDING_DISMISSED_KEY = "relationship-chat.onboarding-dismissed";

function createInitialGameState() {
  return {
    schema_version: "relationship_game_score_v1",
    max_turns: GAME_MAX_TURNS,
    turn_count: 0,
    score: 0,
    title: "谨慎修复",
    highest_score: 0,
    highest_title: "谨慎修复",
    is_complete: false,
    completion_reason: null,
    rounds: [],
  };
}

const state = {
  cases: [],
  caseIndex: 0,
  customCase: null,
  visitorId: "",
  sessionId: "",
  gameLogId: "",
  playedCaseIds: new Set(),
  game: createInitialGameState(),
  perfectReplies: [],
  liveBestStrategy: "",
  liveRecommendedReply: "",
  consentForDataset: false,
  turns: [],
};
let isReplyComposing = false;

const elements = {
  sceneText: document.querySelector("#sceneText"),
  stageTag: document.querySelector("#stageTag"),
  emotionTag: document.querySelector("#emotionTag"),
  wrongReply: document.querySelector("#wrongReply"),
  bestStrategy: document.querySelector("#bestStrategy"),
  recommendedReply: document.querySelector("#recommendedReply"),
  chatLog: document.querySelector("#chatLog"),
  replyForm: document.querySelector("#replyForm"),
  replyInput: document.querySelector("#replyInput"),
  completionActions: document.querySelector("#completionActions"),
  newGameButton: document.querySelector("#newGameButton"),
  completionHistoryButton: document.querySelector("#completionHistoryButton"),
  adjustSceneButton: document.querySelector("#adjustSceneButton"),
  statusText: document.querySelector("#statusText"),
  sendButton: document.querySelector("#sendButton"),
  scoreBadge: document.querySelector("#scoreBadge"),
  previousRoundScore: document.querySelector("#previousRoundScore"),
  turnProgress: document.querySelector("#turnProgress"),
  settingsButton: document.querySelector("#settingsButton"),
  historyButton: document.querySelector("#historyButton"),
  onboardingPanel: document.querySelector("#onboardingPanel"),
  dismissOnboardingButton: document.querySelector("#dismissOnboardingButton"),
  backFromHistoryButton: document.querySelector("#backFromHistoryButton"),
  refreshHistoryButton: document.querySelector("#refreshHistoryButton"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  backToChatButton: document.querySelector("#backToChatButton"),
  chatScreen: document.querySelector("#chatScreen"),
  settingsScreen: document.querySelector("#settingsScreen"),
  historyScreen: document.querySelector("#historyScreen"),
  historyList: document.querySelector("#historyList"),
  nextCaseButton: document.querySelector("#nextCaseButton"),
  useCustomCaseButton: document.querySelector("#useCustomCaseButton"),
  customSceneInput: document.querySelector("#customSceneInput"),
  customStageSelect: document.querySelector("#customStageSelect"),
  customEmotionSelect: document.querySelector("#customEmotionSelect"),
  customRiskSelect: document.querySelector("#customRiskSelect"),
  resetCustomCaseButton: document.querySelector("#resetCustomCaseButton"),
  datasetConsentToggle: document.querySelector("#datasetConsentToggle"),
  restartCaseButton: document.querySelector("#restartCaseButton"),
  useRecommendedButton: document.querySelector("#useRecommendedButton"),
  riskAfterScore: document.querySelector("#riskAfterScore"),
  verdictText: document.querySelector("#verdictText"),
  scoreBreakdownText: document.querySelector("#scoreBreakdownText"),
  nextSuggestion: document.querySelector("#nextSuggestion"),
};

function currentCase() {
  if (state.customCase) return state.customCase;
  return state.cases[state.caseIndex];
}

function currentRecommendedReply() {
  return state.liveRecommendedReply || currentCase().recommended_reply;
}

function initialAssistantTurns() {
  return [
    { role: "advisor", text: state.liveBestStrategy },
    { role: "copywriter", text: state.liveRecommendedReply },
  ].filter((turn) => turn.text);
}

function setStatus(text) {
  elements.statusText.textContent = text;
}

function showScreen(name) {
  const isSettings = name === "settings";
  const isHistory = name === "history";
  elements.chatScreen.classList.toggle("active", !isSettings && !isHistory);
  elements.settingsScreen.classList.toggle("active", isSettings);
  elements.historyScreen.classList.toggle("active", isHistory);
}

function loadDatasetConsent() {
  return localStorage.getItem(DATASET_CONSENT_KEY) === "true";
}

function saveDatasetConsent(value) {
  state.consentForDataset = Boolean(value);
  localStorage.setItem(DATASET_CONSENT_KEY, state.consentForDataset ? "true" : "false");
  elements.datasetConsentToggle.checked = state.consentForDataset;
}

function updateOnboardingVisibility() {
  elements.onboardingPanel.hidden = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true";
}

function resetJudge() {
  elements.previousRoundScore.textContent = "-";
  elements.riskAfterScore.textContent = "-";
  elements.verdictText.textContent = "发出第一句后，这里会显示裁判判断。";
  elements.scoreBreakdownText.textContent = "评分会拆成安全闸门、回复质量和关系变化。";
  elements.nextSuggestion.textContent = "如果触发边界，模拟器会明确建议停止推进。";
}

function renderChat() {
  elements.chatLog.innerHTML = "";

  const intro = document.createElement("div");
  intro.className = "message target";
  intro.innerHTML = `<span>场景</span><p>${escapeHtml(currentCase().real_relationship_scene)}</p>`;
  elements.chatLog.append(intro);

  for (const turn of state.turns) {
    const row = document.createElement("div");
    row.className = `message ${turn.role}`;
    row.innerHTML = buildTurnHtml(turn);
    elements.chatLog.append(row);
  }

  if (state.game.is_complete) {
    elements.chatLog.append(buildSettlementBubble());
  }

  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function buildTurnHtml(turn) {
  const labels = {
    user: "你",
    target: "对方",
    advisor: "策略师",
    copywriter: "话术师 80分",
  };
  const safeText = escapeHtml(turn.text);
  const action =
    turn.role === "copywriter" && !state.game.is_complete
      ? `<button class="bubble-fill-button" type="button" data-fill-reply="${encodeURIComponent(turn.text)}">填入</button>`
      : "";

  return `<span>${labels[turn.role] ?? "系统"}</span><div class="bubble-row"><p>${safeText}</p>${action}</div>`;
}

function buildSettlementBubble() {
  const bubble = document.createElement("div");
  bubble.className = "message settlement";
  const bestRound = state.game.rounds.reduce((best, round) => (!best || round.score_delta > best.score_delta ? round : best), null);
  const worstRound = state.game.rounds.reduce((worst, round) => (!worst || round.score_delta < worst.score_delta ? round : worst), null);
  const perfectReference = buildPerfectReferenceHtml(state.perfectReplies);
  bubble.innerHTML = [
    "<span>本局结算</span>",
    '<div class="settlement-card">',
    '<div class="settlement-hero">',
    "<span>最终成绩</span>",
    `<strong>${formatScore(state.game.score)}｜${escapeHtml(state.game.title)}</strong>`,
    `<p>最高称号：${escapeHtml(state.game.highest_title)}（${formatScore(state.game.highest_score)}）</p>`,
    `<p>结束原因：${completionReasonText(state.game.completion_reason)}</p>`,
    "</div>",
    '<div class="settlement-section">',
    "<h3>为什么得分</h3>",
    bestRound ? `<p><b>最好回合</b> 第 ${bestRound.turn} 轮 ${formatScore(bestRound.score_delta)}，${escapeHtml(bestRound.verdict)}</p>` : "",
    worstRound ? `<p><b>最需要调整</b> 第 ${worstRound.turn} 轮 ${formatScore(worstRound.score_delta)}，${escapeHtml(worstRound.verdict)}</p>` : "",
    "</div>",
    perfectReference,
    "</div>",
  ].join("");
  return bubble;
}

function buildPerfectReferenceHtml(items) {
  if (!items.length) return "";
  const visibleItems = items.slice(0, 3);
  const remainingCount = items.length - visibleItems.length;
  return [
    '<details class="perfect-reference" open>',
    `<summary>满分参考${remainingCount > 0 ? `（先看 ${visibleItems.length} 条，另有 ${remainingCount} 条）` : ""}</summary>`,
    "<ol>",
    ...visibleItems.map((item) => `<li><span>第 ${item.turn} 轮</span>${escapeHtml(item.text)}</li>`),
    "</ol>",
    "</details>",
  ].join("");
}

function renderCase() {
  const item = currentCase();
  state.gameLogId = createGameLogId();
  state.liveBestStrategy = item.best_strategy;
  state.liveRecommendedReply = item.recommended_reply;
  elements.sceneText.classList.remove("loading");
  elements.sceneText.textContent = item.real_relationship_scene;
  elements.stageTag.textContent = item.relationship_stage_label;
  elements.emotionTag.textContent = item.target_emotion_label;
  elements.wrongReply.textContent = item.wrong_reply;
  elements.bestStrategy.textContent = state.liveBestStrategy;
  elements.recommendedReply.textContent = state.liveRecommendedReply;
  state.turns = initialAssistantTurns();
  elements.replyInput.value = "";
  state.game = createInitialGameState();
  state.perfectReplies = [];
  resetJudge();
  renderGameHud();
  renderChat();
  setStatus("等待输入");
}

function buildCustomCase() {
  const scene = elements.customSceneInput.value.trim();
  if (!scene) {
    throw new Error("先填自定义场景");
  }

  return {
    id: `custom_${Date.now()}`,
    real_relationship_scene: scene,
    relationship_stage_label: elements.customStageSelect.value,
    target_emotion_label: elements.customEmotionSelect.value,
    risk_level: elements.customRiskSelect.value,
    wrong_reply: "未设置。裁判会根据当前场景和你的回复判断是否施压、越界或不尊重边界。",
    best_strategy: "先承认自己的追问给了对方压力，再给对方空间，并用一句轻量邀请保留后续沟通。",
    recommended_reply: "我明白，昨晚我连续追问确实让你有压力了。你先好好休息，不用急着回我，等你状态好一点我们再慢慢聊。",
    user_feedback: null,
    generator_meta: {
      source: "custom",
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fillDefaultCustomScene() {
  elements.customSceneInput.value = DEFAULT_CUSTOM_SCENE;
  randomizeSelect(elements.customStageSelect);
  randomizeSelect(elements.customEmotionSelect);
  randomizeSelect(elements.customRiskSelect);
}

function randomizeSelect(select) {
  if (!select.options.length) return;
  select.selectedIndex = Math.floor(Math.random() * select.options.length);
}

function getVisitorId() {
  const key = "relationship-chat.visitor-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next =
    crypto.randomUUID?.() ??
    `visitor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, next);
  return next;
}

function loadPlayedCaseIds() {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYED_CASE_IDS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function savePlayedCaseIds() {
  localStorage.setItem(PLAYED_CASE_IDS_KEY, JSON.stringify([...state.playedCaseIds]));
}

async function syncPlayedCaseIdsFromHistory() {
  if (!state.visitorId) return;
  try {
    const response = await fetch(`api/completed-cases?visitorId=${encodeURIComponent(state.visitorId)}`);
    const data = await readJsonResponse(response, "已完成场景读取失败");
    for (const caseId of data.case_ids ?? []) {
      state.playedCaseIds.add(caseId);
    }
    savePlayedCaseIds();
  } catch {
    // 历史同步失败不阻断开局，仍用本地已完成记录避重。
  }
}

function rememberCompletedCase() {
  const item = currentCase();
  if (state.customCase || !item?.id || !state.game.is_complete) return;
  state.playedCaseIds.add(item.id);
  savePlayedCaseIds();
}

function chooseRandomSeededCase({ avoidCurrent = false } = {}) {
  const currentCaseId = avoidCurrent && !state.customCase ? currentCase()?.id : "";
  const nextIndex = chooseRandomCaseIndex(state.cases, {
    playedCaseIds: state.playedCaseIds,
    currentCaseId,
  });
  if (nextIndex >= 0) {
    state.caseIndex = nextIndex;
    state.customCase = null;
  }
}

function createGameLogId() {
  return `game_${crypto.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function renderGameHud(lastRound = null) {
  const game = state.game;
  elements.scoreBadge.textContent = `总分 ${formatScore(game.score)}`;
  elements.previousRoundScore.textContent = lastRound ? formatScore(roundDisplayScore(lastRound)) : "-";
  elements.riskAfterScore.textContent = lastRound?.judge?.risk_level_after ?? "-";
  elements.turnProgress.textContent = `${game.turn_count}/${game.max_turns}`;
  elements.sendButton.disabled = Boolean(game.is_complete);
  elements.replyForm.hidden = Boolean(game.is_complete);
  elements.completionActions.hidden = !game.is_complete;
  elements.useRecommendedButton.disabled = Boolean(game.is_complete);
}

function roundDisplayScore(round) {
  if (typeof round.display_score === "number") return round.display_score;
  if (typeof round.raw_score === "number") return Math.round(round.raw_score / 3);
  return "-";
}

function formatScore(value) {
  if (value === null || value === undefined || value === "-") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number > 0 ? `+${number}` : String(number);
}

function completionReasonText(reason) {
  return {
    max_turns: "10 次对话完成",
    blocked: "历史 blocked 风险记录",
    score_floor: "分数到达 -100",
    score_ceiling: "分数到达 100",
    stale_loop: "重复收尾，自动结束",
    natural_end: "自然收尾完成",
  }[reason] ?? "本局结束";
}

async function createSession() {
  state.visitorId = getVisitorId();
  const response = await fetch("api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      visitorId: state.visitorId,
      consentForDataset: state.consentForDataset,
    }),
  });
  const data = await readJsonResponse(response, "无法建立会话");
  state.sessionId = data.session.id;
}

function applySimulationResult(result) {
  const recommendedReply = result.recommended_reply_80 ?? result.recommended_reply;
  if (result.target_reply) {
    state.turns.push({ role: "target", text: result.target_reply });
  }
  if (result.best_strategy) {
    const verdict = result.judge?.verdict ? `判断：${result.judge.verdict}\n策略：${result.best_strategy}` : result.best_strategy;
    state.turns.push({ role: "advisor", text: verdict });
  }
  if (recommendedReply) {
    state.turns.push({ role: "copywriter", text: recommendedReply });
  }
  if (result.perfect_reply_100 && result.game?.turn_count) {
    state.perfectReplies.push({ turn: result.game.turn_count, text: result.perfect_reply_100 });
  }

  const displayJudge = result.game?.rounds?.at(-1)?.judge ?? result.judge ?? {};
  const scoreBreakdown = result.game?.rounds?.at(-1)?.score_breakdown;
  elements.verdictText.textContent = displayJudge.verdict ?? "没有返回评语";
  elements.scoreBreakdownText.textContent = formatScoreBreakdown(scoreBreakdown);
  elements.nextSuggestion.textContent = result.next_suggestion ?? "没有返回下一步建议";
  if (result.best_strategy) {
    state.liveBestStrategy = result.best_strategy;
    elements.bestStrategy.textContent = result.best_strategy;
  }
  if (recommendedReply) {
    state.liveRecommendedReply = recommendedReply;
    elements.recommendedReply.textContent = recommendedReply;
  }
  if (result.game) {
    state.game = result.game;
    rememberCompletedCase();
  }
  renderGameHud(result.game?.rounds?.at(-1) ?? null);
}

function formatScoreBreakdown(scoreBreakdown) {
  if (!scoreBreakdown) return "本轮没有返回评分拆解。";
  const safetyGateLabels = {
    clear: "安全",
    caution: "谨慎",
    high_risk: "高风险",
    blocked: "拦截",
  };
  const qualityLabels = {
    unsafe: "不安全",
    weak: "偏弱",
    acceptable: "可接受",
    good: "良好",
    excellent: "优秀",
  };
  const safetyGate = safetyGateLabels[scoreBreakdown.safety_gate] ?? scoreBreakdown.safety_gate;
  const qualityLevel = qualityLabels[scoreBreakdown.reply_quality_level] ?? scoreBreakdown.reply_quality_level;
  const relationshipDelta = formatScore(scoreBreakdown.relationship_delta_score);
  const conflict = scoreBreakdown.evidence_conflict ? "；证据与分数矛盾，已降级" : "";
  return `安全闸门：${safetyGate}｜回复质量：${qualityLevel} ${scoreBreakdown.reply_quality_score}/100｜关系变化：${relationshipDelta}${conflict}`;
}

async function loadCases() {
  const response = await fetch("api/cases");
  if (!response.ok) {
    throw new Error("无法读取场景数据");
  }
  const data = await readJsonResponse(response, "无法读取场景数据");
  state.cases = shuffleCases(data.cases ?? []);
  if (!state.cases.length) {
    throw new Error("没有可用场景，请先生成 relationship-cases-deepseek.extracted.jsonl");
  }
  state.playedCaseIds = loadPlayedCaseIds();
  await syncPlayedCaseIdsFromHistory();
  chooseRandomSeededCase();
  renderCase();
}

async function simulate(userReply, mode = "chat") {
  if (!state.sessionId) {
    await createSession();
  }

  const response = await fetch("api/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: state.sessionId,
      gameId: state.gameLogId,
      caseId: currentCase().id,
      customCase: state.customCase,
      turns: state.turns,
      userReply,
      consentForDataset: state.consentForDataset,
      gameState: state.game,
      mode,
    }),
  });

  return readJsonResponse(response, "模拟失败");
}

async function primeCustomCase() {
  state.game = createInitialGameState();
  state.perfectReplies = [];
  state.turns = [];
  renderGameHud();
  renderChat();
  setStatus("DeepSeek 正在初始化场景...");
  elements.sendButton.disabled = true;
  elements.useCustomCaseButton.disabled = true;

  try {
    const result = await simulate("初始化这个自定义场景，给出开局判断和我下一句可以怎么回。", "prime");
    applySimulationResult(result);
    renderChat();
    setStatus("场景已初始化");
  } catch (error) {
    state.turns.push({
      role: "advisor",
      text: error instanceof Error ? error.message : String(error),
    });
    renderChat();
    setStatus("初始化失败");
  } finally {
    elements.sendButton.disabled = Boolean(state.game.is_complete);
    elements.useCustomCaseButton.disabled = false;
  }
}

elements.replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.game.is_complete) return;
  const text = elements.replyInput.value.trim();
  if (!text) return;

  state.turns.push({ role: "user", text });
  elements.replyInput.value = "";
  renderChat();
  setStatus("DeepSeek 正在模拟...");
  elements.sendButton.disabled = true;

  try {
    const result = await simulate(text);
    applySimulationResult(result);
    renderChat();
    setStatus(state.game.is_complete ? "本局完成" : "等待下一句");
  } catch (error) {
    state.turns.push({
      role: "advisor",
      text: error instanceof Error ? error.message : String(error),
    });
    renderChat();
    setStatus("模拟失败");
  } finally {
    elements.sendButton.disabled = Boolean(state.game.is_complete);
  }
});

elements.chatLog.addEventListener("click", (event) => {
  const button = event.target.closest(".bubble-fill-button");
  if (button) {
    if (state.game.is_complete) return;
    elements.replyInput.value = decodeURIComponent(button.dataset.fillReply ?? "");
    elements.replyInput.focus();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-history") {
    showHistory();
  }
  if (action === "new-game") {
    startNewGame();
  }
});

elements.replyInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || isReplyComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!elements.sendButton.disabled) {
    elements.replyForm.requestSubmit();
  }
});

elements.replyInput.addEventListener("compositionstart", () => {
  isReplyComposing = true;
});

elements.replyInput.addEventListener("compositionend", () => {
  isReplyComposing = false;
});

elements.settingsButton.addEventListener("click", () => {
  showScreen("settings");
});

elements.historyButton.addEventListener("click", () => {
  showHistory();
});

elements.backFromHistoryButton.addEventListener("click", () => {
  showScreen("chat");
});

elements.refreshHistoryButton.addEventListener("click", () => {
  showHistory();
});

elements.clearHistoryButton.addEventListener("click", async () => {
  if (!confirm("确定清空本机这个访客的全部历史记录吗？")) return;
  if (!state.visitorId) {
    state.visitorId = getVisitorId();
  }
  elements.clearHistoryButton.disabled = true;
  try {
    const response = await fetch(`api/history?visitorId=${encodeURIComponent(state.visitorId)}`, {
      method: "DELETE",
    });
    await readJsonResponse(response, "清空历史失败");
    state.playedCaseIds = new Set();
    savePlayedCaseIds();
    renderHistory([]);
    setStatus("历史已清空");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    elements.clearHistoryButton.disabled = false;
  }
});

elements.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-session-id]");
  if (!button) return;
  if (!confirm("确定删除这一局历史吗？")) return;
  const sessionId = button.dataset.deleteSessionId;
  if (!sessionId) return;
  if (!state.visitorId) {
    state.visitorId = getVisitorId();
  }
  button.disabled = true;
  try {
    const response = await fetch(
      `api/history?visitorId=${encodeURIComponent(state.visitorId)}&sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    await readJsonResponse(response, "删除历史失败");
    await showHistory();
    setStatus("已删除这一局历史");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
});

elements.datasetConsentToggle.addEventListener("change", () => {
  saveDatasetConsent(elements.datasetConsentToggle.checked);
  setStatus(state.consentForDataset ? "已允许进入数据集" : "数据集授权已关闭");
});

elements.dismissOnboardingButton.addEventListener("click", () => {
  localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true");
  updateOnboardingVisibility();
});

elements.backToChatButton.addEventListener("click", () => {
  showScreen("chat");
  if (!state.game.is_complete) {
    elements.replyInput.focus();
  }
});

elements.nextCaseButton.addEventListener("click", () => {
  chooseRandomSeededCase({ avoidCurrent: true });
  renderCase();
});

elements.useCustomCaseButton.addEventListener("click", async () => {
  try {
    state.customCase = buildCustomCase();
    renderCase();
    showScreen("chat");
    await primeCustomCase();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
});

elements.resetCustomCaseButton.addEventListener("click", () => {
  fillDefaultCustomScene();
  setStatus("已随机恢复自定义示例");
});

elements.restartCaseButton.addEventListener("click", () => {
  restartCurrentCase();
});

elements.useRecommendedButton.addEventListener("click", () => {
  if (state.game.is_complete) return;
  elements.replyInput.value = currentRecommendedReply();
  showScreen("chat");
  elements.replyInput.focus();
});

elements.newGameButton.addEventListener("click", () => {
  startNewGame();
});

elements.completionHistoryButton.addEventListener("click", () => {
  showHistory();
});

elements.adjustSceneButton.addEventListener("click", () => {
  showScreen("settings");
});

async function startNewGame() {
  try {
    await createSession();
    chooseRandomSeededCase({ avoidCurrent: true });
    renderCase();
    showScreen("chat");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function restartCurrentCase() {
  try {
    await createSession();
    renderCase();
    showScreen("chat");
    if (state.customCase) {
      await primeCustomCase();
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function showHistory() {
  showScreen("history");
  if (!state.visitorId) {
    state.visitorId = getVisitorId();
  }
  elements.historyList.innerHTML = '<p class="muted">正在读取历史...</p>';
  try {
    const response = await fetch(`api/history?visitorId=${encodeURIComponent(state.visitorId)}`);
    const data = await readJsonResponse(response, "历史读取失败");
    renderHistory(data.history ?? []);
  } catch (error) {
    elements.historyList.innerHTML = `<p class="muted">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function renderHistory(history) {
  if (!history.length) {
    elements.historyList.innerHTML = '<p class="muted">还没有历史记录。</p>';
    return;
  }
  elements.historyList.innerHTML = history
    .map((item) => {
      const scene = String(item.scene ?? "").split("\n")[0].slice(0, 56);
      const tone = item.final_score >= 31 ? "good" : item.final_score < 0 ? "bad" : "neutral";
      return [
        `<article class="history-card ${tone}">`,
        "<div>",
        `<strong>${escapeHtml(item.final_title)}｜${formatScore(item.final_score)}</strong>`,
        `<p>${escapeHtml(item.relationship_stage_label)} · ${escapeHtml(item.risk_level)} · ${item.turn_count}/${item.max_turns} 轮</p>`,
        `<p>${escapeHtml(scene)}</p>`,
        `<small>最高：${escapeHtml(item.highest_title)} ${formatScore(item.highest_score)} · ${new Date(item.updated_at).toLocaleString()}</small>`,
        item.best_turn ? buildHistoryRoundHtml("最好", item.best_turn) : "",
        item.worst_turn ? buildHistoryRoundHtml("最险", item.worst_turn) : "",
        `<button class="icon-button" type="button" data-delete-session-id="${escapeHtml(item.session_id)}">删除这一局</button>`,
        "</div>",
        "</article>",
      ].join("");
    })
    .join("");
}

function buildHistoryRoundHtml(label, turn) {
  return [
    `<small>${label}：第 ${turn.turn} 轮 ${formatScore(turn.score_delta)}</small>`,
    turn.recommended_reply_80 ? `<p class="history-reply">80分：${escapeHtml(turn.recommended_reply_80)}</p>` : "",
    turn.perfect_reply_100 ? `<p class="history-reply perfect">100分：${escapeHtml(turn.perfect_reply_100)}</p>` : "",
  ].join("");
}

async function initialize() {
  state.consentForDataset = loadDatasetConsent();
  elements.datasetConsentToggle.checked = state.consentForDataset;
  updateOnboardingVisibility();
  fillDefaultCustomScene();
  try {
    await createSession();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
  await loadCases();
}

initialize().catch((error) => {
  elements.sceneText.textContent = error instanceof Error ? error.message : String(error);
  setStatus("初始化失败");
});
