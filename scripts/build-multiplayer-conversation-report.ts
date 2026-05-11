import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type RelationshipCase = {
  id: string;
  real_relationship_scene: string;
  relationship_stage_label: string;
  target_emotion_label: string;
  risk_level: string;
};

type ChatTurn = {
  role: "user" | "target" | "advisor" | "copywriter";
  text: string;
};

type SimulationResult = {
  target_reply?: string;
  best_strategy?: string;
  recommended_reply?: string;
  recommended_reply_80?: string;
  perfect_reply_100?: string;
  judge?: {
    verdict?: string;
    risk_level_after?: string;
    boundary_score?: number;
    pressure_score?: number;
    trust_score?: number;
    empathy_score?: number;
    relevance_score?: number;
    risk_score?: number;
  };
  game?: {
    score: number;
    title: string;
    turn_count: number;
    is_complete: boolean;
    completion_reason: string | null;
    rounds?: Array<{
      turn: number;
      score_delta: number;
      score_after: number;
      title_after: string;
      verdict: string;
      judge: SimulationResult["judge"];
    }>;
  };
};

type DbSessionRow = {
  session_id: string;
  visitor_id: string;
  session_created_at: string;
  session_updated_at: string;
  case_id: string | null;
  turn_count: number;
};

type DbSimulationRow = {
  session_id: string;
  case_id: string;
  turns_json: string;
  user_reply: string;
  result_json: string;
  created_at: string;
};

type ApiSummary = {
  players: Array<{
    player_id: string;
    session_id: string | null;
  }>;
};

type BrowserSummary = {
  players: Array<{
    id: string;
    final_title: string | null;
    final_score: number | null;
    rounds_attempted: number;
    screenshot: string | null;
    video: string | null;
  }>;
};

const serviceManifestPath = ".cache/relationship-chat-multiplayer-live-service.json";
const apiSummaryPath = "output/multiplayer-api-50-live-summary.json";
const browserSummaryPath = "output/playwright/multiplayer-live/browser-players-summary.json";
const casesPath = "data/relationship-cases-deepseek.extracted.jsonl";
const outputPath = "output/multiplayer-live-report.html";

const serviceManifest = JSON.parse(readFileSync(serviceManifestPath, "utf8")) as { dbFile: string };
const apiSummary = readJson<ApiSummary>(apiSummaryPath);
const browserSummary = readJson<BrowserSummary>(browserSummaryPath);
const cases = loadCases();
const conversations = loadConversations();

writeFileSync(outputPath, buildHtml({ generated_at: new Date().toISOString(), conversations }), "utf8");
console.log(`Wrote ${outputPath} with ${conversations.length} conversations`);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadCases() {
  return new Map(
    readFileSync(casesPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const item = JSON.parse(line) as RelationshipCase;
        return [item.id, item] as const;
      }),
  );
}

function loadConversations() {
  const apiPlayerBySession = new Map(
    apiSummary.players
      .filter((player) => player.session_id)
      .map((player) => [player.session_id as string, player.player_id]),
  );

  const db = new DatabaseSync(serviceManifest.dbFile, { readOnly: true });
  try {
    const sessions = db
      .prepare(
        [
          "SELECT sessions.id AS session_id, sessions.visitor_id, sessions.created_at AS session_created_at,",
          "sessions.updated_at AS session_updated_at, MIN(simulations.case_id) AS case_id, COUNT(simulations.id) AS turn_count",
          "FROM sessions",
          "INNER JOIN simulations ON simulations.session_id = sessions.id",
          "GROUP BY sessions.id",
          "ORDER BY sessions.created_at ASC",
        ].join(" "),
      )
      .all() as DbSessionRow[];

    const rows = db
      .prepare(
        [
          "SELECT session_id, case_id, turns_json, user_reply, result_json, created_at",
          "FROM simulations",
          "ORDER BY created_at ASC",
        ].join(" "),
      )
      .all() as DbSimulationRow[];

    const rowsBySession = new Map<string, DbSimulationRow[]>();
    for (const row of rows) {
      const list = rowsBySession.get(row.session_id) ?? [];
      list.push(row);
      rowsBySession.set(row.session_id, list);
    }

    const browserSessions = inferBrowserSessionIds(sessions, apiPlayerBySession);

    return sessions.map((session, index) => {
      const sessionRows = rowsBySession.get(session.session_id) ?? [];
      const firstRow = sessionRows[0];
      const lastRow = sessionRows.at(-1);
      const lastResult = lastRow ? safeJson<SimulationResult>(lastRow.result_json) : null;
      const caseInfo = cases.get(firstRow?.case_id ?? session.case_id ?? "");
      const source = apiPlayerBySession.has(session.session_id)
        ? "API"
        : browserSessions.has(session.session_id)
          ? "Browser"
          : "Other";
      const playerLabel =
        apiPlayerBySession.get(session.session_id) ??
        browserSessions.get(session.session_id) ??
        `${source}-${index + 1}`;

      return {
        id: session.session_id,
        visitor_id: session.visitor_id,
        player_label: playerLabel,
        source,
        created_at: session.session_created_at,
        updated_at: session.session_updated_at,
        case_id: firstRow?.case_id ?? session.case_id ?? "unknown",
        stage: caseInfo?.relationship_stage_label ?? "未知阶段",
        emotion: caseInfo?.target_emotion_label ?? "未知情绪",
        initial_risk: caseInfo?.risk_level ?? "unknown",
        scene: caseInfo?.real_relationship_scene ?? "未找到场景文本",
        final_score: lastResult?.game?.score ?? null,
        final_title: lastResult?.game?.title ?? "未结算",
        turn_count: lastResult?.game?.turn_count ?? sessionRows.length,
        is_complete: Boolean(lastResult?.game?.is_complete),
        completion_reason: lastResult?.game?.completion_reason ?? null,
        messages: buildMessages(sessionRows),
      };
    });
  } finally {
    db.close();
  }
}

function inferBrowserSessionIds(sessions: DbSessionRow[], apiPlayerBySession: Map<string, string>) {
  const browserRows = sessions
    .filter((session) => !apiPlayerBySession.has(session.session_id) && session.turn_count > 0)
    .sort((a, b) => b.session_created_at.localeCompare(a.session_created_at))
    .slice(0, browserSummary.players.length)
    .reverse();
  return new Map(
    browserRows.map((session, index) => [
      session.session_id,
      browserSummary.players[index]?.id ?? `browser-${index + 1}`,
    ]),
  );
}

function buildMessages(rows: DbSimulationRow[]) {
  const messages: Array<{
    role: ChatTurn["role"] | "round";
    label: string;
    text: string;
    round?: number;
    created_at?: string;
  }> = [];

  rows.forEach((row, rowIndex) => {
    const result = safeJson<SimulationResult>(row.result_json);
    const round = result.game?.rounds?.at(-1);
    const roundNumber = result.game?.turn_count ?? rowIndex + 1;

    messages.push({
      role: "round",
      label: `第 ${roundNumber} 轮`,
      text: "",
      round: roundNumber,
      created_at: row.created_at,
    });
    messages.push({ role: "user", label: "你", text: row.user_reply, round: roundNumber, created_at: row.created_at });
    if (result.target_reply) {
      messages.push({ role: "target", label: "对方", text: result.target_reply, round: roundNumber, created_at: row.created_at });
    }
    if (result.best_strategy) {
      messages.push({ role: "advisor", label: "策略师", text: result.best_strategy, round: roundNumber, created_at: row.created_at });
    }
    const recommended = result.recommended_reply_80 ?? result.recommended_reply;
    if (recommended) {
      messages.push({ role: "copywriter", label: "话术师 80分", text: recommended, round: roundNumber, created_at: row.created_at });
    }
  });

  return messages;
}

function safeJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return {} as T;
  }
}

function buildHtml(data: { generated_at: string; conversations: ReturnType<typeof loadConversations> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>多玩家聊天记录</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef0f2;
        --panel: #ffffff;
        --ink: #171a1f;
        --muted: #6b7280;
        --line: #d9dee5;
        --user: #0f8b8d;
        --target: #ffffff;
        --advisor: #fff7ed;
        --copywriter: #edf7ee;
        --round: #111827;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        height: 100vh;
        overflow: hidden;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      button, input, select {
        font: inherit;
      }
      .app {
        display: grid;
        grid-template-columns: 340px 1fr;
        height: 100vh;
      }
      aside {
        display: grid;
        grid-template-rows: auto auto 1fr;
        min-width: 0;
        border-right: 1px solid var(--line);
        background: #f8f9fa;
      }
      .sidebar-head {
        padding: 18px 16px 12px;
        border-bottom: 1px solid var(--line);
      }
      h1 {
        margin: 0 0 6px;
        font-size: 22px;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .controls {
        display: grid;
        gap: 8px;
        padding: 12px;
        border-bottom: 1px solid var(--line);
      }
      .controls input, .controls select {
        width: 100%;
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 10px;
        background: #fff;
      }
      .conversation-list {
        overflow: auto;
        padding: 8px;
      }
      .conversation-item {
        width: 100%;
        display: grid;
        gap: 6px;
        margin: 0 0 8px;
        padding: 12px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .conversation-item:hover {
        background: #fff;
      }
      .conversation-item.active {
        border-color: #9fb5c1;
        background: #fff;
      }
      .item-top, .chat-head-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        background: #e7ebef;
        color: #303740;
        font-size: 12px;
        white-space: nowrap;
      }
      .pill.api { background: #e6f3f3; color: #0b6f72; }
      .pill.browser { background: #fef3e6; color: #9a4c10; }
      main {
        display: grid;
        grid-template-rows: auto 1fr;
        min-width: 0;
        height: 100vh;
      }
      .chat-head {
        padding: 16px 20px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(10px);
      }
      .chat-title {
        display: grid;
        gap: 4px;
      }
      .chat-title strong {
        font-size: 20px;
      }
      .chat-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .chat-area {
        overflow: auto;
        padding: 22px clamp(14px, 4vw, 42px);
      }
      .messages {
        max-width: 880px;
        margin: 0 auto;
        display: grid;
        gap: 12px;
      }
      .msg {
        display: grid;
        gap: 5px;
        max-width: min(720px, 92%);
      }
      .msg.user {
        justify-self: end;
      }
      .msg.round {
        justify-self: stretch;
        max-width: 100%;
        margin: 14px 0 4px;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        padding: 0 4px;
      }
      .bubble {
        padding: 11px 13px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--target);
        line-height: 1.65;
        white-space: pre-wrap;
      }
      .user .bubble {
        border-color: var(--user);
        background: var(--user);
        color: #fff;
      }
      .advisor .bubble {
        background: var(--advisor);
      }
      .copywriter .bubble {
        background: var(--copywriter);
      }
      .round .bubble {
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        text-align: center;
        font-size: 12px;
      }
      .round .bubble::before,
      .round .bubble::after {
        content: "";
        display: inline-block;
        width: min(120px, 18vw);
        height: 1px;
        margin: 0 10px 4px;
        background: var(--line);
      }
      .empty {
        padding: 40px;
        color: var(--muted);
      }
      @media (max-width: 860px) {
        body { height: auto; overflow: auto; }
        .app {
          grid-template-columns: 1fr;
          height: auto;
        }
        aside, main {
          height: auto;
        }
        .conversation-list {
          max-height: 320px;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside>
        <div class="sidebar-head">
          <h1>聊天记录</h1>
          <div class="muted">每一局一条记录，点击左侧看完整聊天。</div>
        </div>
        <div class="controls">
          <input id="search" type="search" placeholder="搜索玩家或聊天内容" />
          <select id="sourceFilter">
            <option value="">全部来源</option>
            <option value="Browser">浏览器玩家</option>
            <option value="API">API 玩家</option>
          </select>
        </div>
        <div id="conversationList" class="conversation-list"></div>
      </aside>
      <main>
        <header class="chat-head">
          <div class="chat-head-top">
            <div class="chat-title">
              <strong id="chatTitle">选择一局</strong>
              <span id="chatSubtitle" class="muted"></span>
            </div>
          </div>
          <div id="chatMeta" class="chat-meta"></div>
        </header>
        <section id="chatArea" class="chat-area">
          <div class="empty">从左侧选择一局，就能看完整聊天。</div>
        </section>
      </main>
    </div>
    <script id="reportData" type="application/json">${json}</script>
    <script>
      const data = JSON.parse(document.getElementById("reportData").textContent);
      const conversations = data.conversations;
      const listEl = document.getElementById("conversationList");
      const searchEl = document.getElementById("search");
      const sourceEl = document.getElementById("sourceFilter");
      let activeId = conversations[0]?.id ?? null;

      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));

      function filteredConversations() {
        const keyword = searchEl.value.trim().toLowerCase();
        const source = sourceEl.value;
        return conversations.filter((item) => {
          if (source && item.source !== source) return false;
          if (!keyword) return true;
          const text = [
            item.player_label,
            item.source,
            ...item.messages.map((message) => message.text),
          ].join(" ").toLowerCase();
          return text.includes(keyword);
        });
      }

      function renderList() {
        const items = filteredConversations();
        if (!items.some((item) => item.id === activeId)) activeId = items[0]?.id ?? null;
        listEl.innerHTML = items.map((item) => {
          const sourceClass = item.source === "Browser" ? "browser" : item.source === "API" ? "api" : "";
          return '<button class="conversation-item ' + (item.id === activeId ? "active" : "") + '" type="button" data-id="' + esc(item.id) + '">' +
            '<div class="item-top"><strong>' + esc(item.player_label) + '</strong><span class="pill ' + sourceClass + '">' + esc(item.source) + '</span></div>' +
            '<div class="muted">' + esc(item.turn_count) + ' 轮聊天</div>' +
          '</button>';
        }).join("");
        listEl.querySelectorAll("[data-id]").forEach((button) => {
          button.addEventListener("click", () => {
            activeId = button.dataset.id;
            renderList();
            renderChat();
          });
        });
        renderChat();
      }

      function renderChat() {
        const item = conversations.find((conversation) => conversation.id === activeId);
        if (!item) {
          document.getElementById("chatTitle").textContent = "没有匹配结果";
          document.getElementById("chatSubtitle").textContent = "";
          document.getElementById("chatScore").textContent = "";
          document.getElementById("chatMeta").innerHTML = "";
          document.getElementById("chatArea").innerHTML = '<div class="empty">没有匹配的聊天。</div>';
          return;
        }
        document.getElementById("chatTitle").textContent = item.player_label;
        document.getElementById("chatSubtitle").textContent = item.source + " / " + item.turn_count + " 轮聊天";
        document.getElementById("chatMeta").innerHTML = [
        ].join("");
        document.getElementById("chatArea").innerHTML =
          '<div class="messages">' + item.messages.map(renderMessage).join("") + '</div>';
      }

      function pill(text) {
        return '<span class="pill">' + esc(text) + '</span>';
      }

      function renderMessage(message) {
        if (message.role === "round") {
          return '<div class="msg round">' +
            '<div class="bubble">' + esc(message.label) + '</div>' +
          '</div>';
        }
        return '<div class="msg ' + esc(message.role) + '">' +
          '<div class="label">' + esc(message.label) + '</div>' +
          '<div class="bubble">' + esc(message.text) + '</div>' +
        '</div>';
      }

      searchEl.addEventListener("input", renderList);
      sourceEl.addEventListener("input", renderList);
      renderList();
    </script>
  </body>
</html>`;
}
