import { readFileSync, writeFileSync } from "node:fs";

const titleLivePath = "output/deepseek-title-coverage-live.json";
const titleAuditPath = "output/deepseek-title-coverage-audit.json";
const multiturnPath = "output/deepseek-multiturn-quality-live.json";
const outputPath = "output/deepseek-data-viewer.html";

const data = {
  generated_at: new Date().toISOString(),
  source_files: {
    title_live: titleLivePath,
    title_audit: titleAuditPath,
    multiturn: multiturnPath,
  },
  title_live: readJson(titleLivePath),
  title_audit: readJson(titleAuditPath),
  multiturn: readJson(multiturnPath),
};

writeFileSync(outputPath, buildHtml(data), "utf8");
console.log(`Wrote ${outputPath}`);

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildHtml(input: typeof data) {
  const json = JSON.stringify(input).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DeepSeek 聊天数据</title>
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
        --perfect: #edf4ff;
        --suggestion: #fffbe8;
        --round: #111827;
        --good: #147a4d;
        --bad: #b42318;
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
      button {
        color: inherit;
      }
      .app {
        display: grid;
        grid-template-columns: 360px 1fr;
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
      .summary {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
      }
      .summary-item {
        min-height: 58px;
        padding: 9px 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
      }
      .summary-item span {
        display: block;
        color: var(--muted);
        font-size: 11px;
      }
      .summary-item strong {
        display: block;
        margin-top: 5px;
        font-size: 17px;
      }
      .controls {
        display: grid;
        gap: 8px;
        padding: 12px;
        border-bottom: 1px solid var(--line);
      }
      .filter-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .controls input,
      .controls select {
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
      .item-top,
      .chat-head-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .item-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .item-scene {
        display: -webkit-box;
        overflow: hidden;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
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
      .pill.title { background: #e6f3f3; color: #0b6f72; }
      .pill.multi { background: #fef3e6; color: #9a4c10; }
      .pill.audit { background: #eef2ff; color: #3442a8; }
      .pill.sample { background: #edf4ff; color: #28518f; }
      .pill.good { background: #e7f6ee; color: var(--good); }
      .pill.bad { background: #fff0ed; color: var(--bad); }
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
        min-width: 0;
        gap: 4px;
      }
      .chat-title strong {
        font-size: 20px;
        overflow-wrap: anywhere;
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
        max-width: 920px;
        margin: 0 auto;
        display: grid;
        gap: 12px;
      }
      .scene-panel,
      .detail-panel {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.72);
        padding: 12px 14px;
        line-height: 1.65;
      }
      .scene-panel strong {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
      }
      .msg {
        display: grid;
        gap: 5px;
        max-width: min(740px, 92%);
      }
      .msg.user,
      .msg.perfect {
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
      .user .label,
      .perfect .label {
        text-align: right;
      }
      .bubble {
        padding: 11px 13px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--target);
        line-height: 1.65;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
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
      .perfect .bubble {
        background: var(--perfect);
      }
      .suggestion .bubble {
        background: var(--suggestion);
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
      details.detail-panel {
        padding: 0;
      }
      details.detail-panel summary {
        cursor: pointer;
        padding: 12px 14px;
        color: #0b6f72;
      }
      pre {
        max-height: 360px;
        overflow: auto;
        margin: 0;
        padding: 0 14px 14px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.5;
      }
      .empty {
        padding: 40px;
        color: var(--muted);
      }
      @media (max-width: 900px) {
        body { height: auto; overflow: auto; }
        .app {
          grid-template-columns: 1fr;
          height: auto;
        }
        aside,
        main {
          height: auto;
        }
        .conversation-list {
          max-height: 360px;
        }
        .chat-head-top {
          align-items: start;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside>
        <div class="sidebar-head">
          <h1>DeepSeek 聊天数据</h1>
          <div class="muted">左边选一条，右边像聊天一样看 DeepSeek 的输入、对方模拟、80分建议、100分参考和下一步。</div>
          <div id="summary" class="summary"></div>
        </div>
        <div class="controls">
          <input id="search" type="search" placeholder="搜索称号、场景、回复、log 文件" />
          <div class="filter-row">
            <select id="sourceFilter">
              <option value="">全部数据</option>
              <option value="title">称号样本</option>
              <option value="multi">多轮质量</option>
              <option value="audit">审计摘要</option>
            </select>
            <select id="resultFilter">
              <option value="">全部结果</option>
              <option value="pass">PASS</option>
              <option value="fail">FAIL</option>
            </select>
          </div>
          <select id="toneFilter">
            <option value="">全部正负向称号</option>
            <option value="positive">positive</option>
            <option value="negative">negative</option>
          </select>
        </div>
        <div id="conversationList" class="conversation-list"></div>
      </aside>
      <main>
        <header class="chat-head">
          <div class="chat-head-top">
            <div class="chat-title">
              <strong id="chatTitle">选择一条数据</strong>
              <span id="chatSubtitle" class="muted"></span>
            </div>
            <span id="chatStatus" class="pill"></span>
          </div>
          <div id="chatMeta" class="chat-meta"></div>
        </header>
        <section id="chatArea" class="chat-area">
          <div class="empty">从左侧选择一条，就能看完整输入输出。</div>
        </section>
      </main>
    </div>
    <script id="reportData" type="application/json">${json}</script>
    <script>
      const data = JSON.parse(document.getElementById("reportData").textContent);
      const conversations = buildConversations();
      const listEl = document.getElementById("conversationList");
      const searchEl = document.getElementById("search");
      const sourceEl = document.getElementById("sourceFilter");
      const resultEl = document.getElementById("resultFilter");
      const toneEl = document.getElementById("toneFilter");
      let activeId = conversations[0] ? conversations[0].id : null;

      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));

      function buildConversations() {
        const titleEntries = (data.title_live.entries || []).map((entry, index) => {
          const title = entry.catalog_title || {};
          const input = entry.deepseek_input || {};
          const output = entry.deepseek_output || {};
          const pass = Boolean(entry.quality && entry.quality.pass) && !entry.error;
          return {
            id: "title-" + index,
            source: "title",
            sourceLabel: "称号样本",
            title: title.title || "未命名称号",
            subtitle: "单轮样本，非完整游戏 / " + (title.id || "unknown") + " / " + (title.tone || "tone?") + " / raw_score " + (entry.raw_score ?? ""),
            scene: input.scene || "",
            tone: title.tone || "",
            pass,
            statusLabel: "单轮样本",
            statusClass: "sample",
            searchable: JSON.stringify(entry),
            meta: [
              ["完整游戏", "否，称号覆盖只跑 1 轮"],
              ["catalog", title.id],
              ["tone", title.tone],
              ["turn_count", entry.game && entry.game.turn_count],
              ["is_complete", entry.game && entry.game.is_complete],
              ["raw_score", entry.raw_score],
              ["game_title", entry.game && entry.game.title],
              ["elapsed", entry.elapsed_ms ? entry.elapsed_ms + "ms" : ""],
              ["log", entry.raw_log_file],
            ],
            messages: compactMessages([
              { role: "round", label: "称号样本 / 单轮输入输出", text: "" },
              { role: "user", label: "用户输入 user_reply", text: input.user_reply },
              { role: "target", label: "DeepSeek 模拟对方 target_reply", text: output.target_reply },
              { role: "advisor", label: "策略师 best_strategy", text: output.best_strategy },
              { role: "copywriter", label: "80分建议 recommended_reply_80", text: output.recommended_reply_80 },
              { role: "perfect", label: "100分参考 perfect_reply_100", text: output.perfect_reply_100 },
              { role: "suggestion", label: "下一步 next_suggestion", text: output.next_suggestion },
            ]),
            detail: {
              judge: output.judge,
              normalized_judge: entry.normalized_judge,
              game: entry.game,
              quality: entry.quality,
              request_contract: entry.deepseek_request_contract,
              response_meta: entry.raw_response_meta,
              fixed_labels: input.fixed_labels,
              previous_turns: input.previous_turns,
              raw_log_file: entry.raw_log_file,
              error: entry.error,
            },
          };
        });

        const games = (data.multiturn.games || []).map((game, index) => {
          const pass = !game.error;
          return {
            id: "multi-" + index,
            source: "multi",
            sourceLabel: "多轮质量",
            title: game.player_id || ("多轮玩家 " + (index + 1)),
            subtitle: (game.case_id || "unknown") + " / " + ((game.turns || []).length) + " turns / " + (game.stop_reason || "no stop"),
            scene: game.scene || "",
            tone: "",
            pass,
            statusLabel: game.completed ? "完整游戏" : "未完成",
            statusClass: game.completed ? "good" : "bad",
            searchable: JSON.stringify(game),
            meta: [
              ["完整游戏", game.completed ? "是" : "否"],
              ["case", game.case_id],
              ["session", game.session_id],
              ["turns", (game.turns || []).length],
              ["completed", game.completed],
              ["stop", game.stop_reason],
              ["log", game.raw_log_file],
            ],
            messages: buildGameMessages(game),
            detail: {
              raw_log_file: game.raw_log_file,
              completed: game.completed,
              stop_reason: game.stop_reason,
              error: game.error,
            },
          };
        });

        const audit = {
          id: "audit-summary",
          source: "audit",
          sourceLabel: "审计摘要",
          title: "审计摘要",
          subtitle: "称号审计 + 多轮质量审计 + source files",
          scene: "这里看的是整批数据有没有明显问题，不是某一轮聊天。",
          tone: "",
          pass: Boolean(data.title_audit.summary && data.title_audit.summary.pass && data.multiturn.summary && data.multiturn.summary.pass),
          statusLabel: data.title_audit.summary && data.title_audit.summary.pass && data.multiturn.summary && data.multiturn.summary.pass ? "PASS" : "FAIL",
          statusClass: data.title_audit.summary && data.title_audit.summary.pass && data.multiturn.summary && data.multiturn.summary.pass ? "good" : "bad",
          searchable: JSON.stringify({ audit: data.title_audit, multiturn: data.multiturn.summary, source_files: data.source_files }),
          meta: [
            ["称号审计", data.title_audit.summary && data.title_audit.summary.pass ? "PASS" : "FAIL"],
            ["多轮质量", data.multiturn.summary && data.multiturn.summary.pass ? "PASS" : "FAIL"],
            ["source", "3 json files"],
          ],
          messages: [
            { role: "round", label: "整批检查", text: "" },
            { role: "advisor", label: "称号审计", text: summaryText(data.title_audit.summary) },
            { role: "copywriter", label: "多轮质量审计", text: summaryText(data.multiturn.summary) },
            { role: "suggestion", label: "数据来源", text: summaryText(data.source_files) },
          ],
          detail: {
            title_audit_summary: data.title_audit.summary,
            title_audit_failures: data.title_audit.failures,
            multiturn_summary: data.multiturn.summary,
            source_files: data.source_files,
            generated_at: data.generated_at,
          },
        };

        return titleEntries.concat(games).concat([audit]);
      }

      function compactMessages(messages) {
        return messages.filter((message) => message.text || message.role === "round");
      }

      function buildGameMessages(game) {
        const messages = [];
        (game.turns || []).forEach((turn) => {
          messages.push({ role: "round", label: "第 " + turn.turn + " 轮", text: "" });
          messages.push({ role: "user", label: "用户输入 user_reply", text: turn.user_reply });
          if (turn.previous_recommended_reply_80) {
            messages.push({ role: "advisor", label: "上一轮 80分建议（用于检查是否回灌）", text: turn.previous_recommended_reply_80 });
          }
          messages.push({ role: "target", label: "DeepSeek 模拟对方 target_reply", text: turn.target_reply });
          messages.push({ role: "copywriter", label: "80分建议 recommended_reply_80", text: turn.recommended_reply_80 });
          messages.push({ role: "perfect", label: "100分参考 perfect_reply_100", text: turn.perfect_reply_100 });
          messages.push({ role: "suggestion", label: "下一步 next_suggestion", text: turn.next_suggestion });
        });
        return compactMessages(messages);
      }

      function renderSummary() {
        const title = data.title_live.summary || {};
        const audit = data.title_audit.summary || {};
        const mt = data.multiturn.summary || {};
        const items = [
          ["称号样本", (title.targeted_catalog_prompt_count || 0) + "/" + (title.title_catalog_count || 0)],
          ["不同场景", title.distinct_scene_count || 0],
          ["多轮数据", (mt.game_count || 0) + "局 / " + (mt.turn_count || 0) + "轮"],
          ["完整游戏", completedGames() + "/" + (mt.game_count || 0)],
          ["审计", audit.pass && mt.pass ? "PASS" : "FAIL"],
        ];
        document.getElementById("summary").innerHTML = items.map((item) =>
          '<div class="summary-item"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>'
        ).join("");
      }

      function filteredConversations() {
        const keyword = searchEl.value.trim().toLowerCase();
        const source = sourceEl.value;
        const result = resultEl.value;
        const tone = toneEl.value;
        return conversations.filter((item) => {
          if (source && item.source !== source) return false;
          if (result && (item.pass ? "pass" : "fail") !== result) return false;
          if (tone && item.tone !== tone) return false;
          if (!keyword) return true;
          return [
            item.title,
            item.subtitle,
            item.scene,
            item.sourceLabel,
            item.searchable,
          ].join(" ").toLowerCase().includes(keyword);
        });
      }

      function renderList() {
        const items = filteredConversations();
        if (!items.some((item) => item.id === activeId)) {
          activeId = items[0] ? items[0].id : null;
        }
        listEl.innerHTML = items.length ? items.map((item) => {
          return '<button class="conversation-item ' + (item.id === activeId ? "active" : "") + '" type="button" data-id="' + esc(item.id) + '">' +
            '<div class="item-top"><strong class="item-title">' + esc(item.title) + '</strong><span class="pill ' + esc(item.source) + '">' + esc(item.sourceLabel) + '</span></div>' +
            '<div class="muted">' + esc(item.subtitle) + '</div>' +
            '<div class="muted item-scene">' + esc(item.scene) + '</div>' +
          '</button>';
        }).join("") : '<div class="empty">没有匹配的数据。</div>';

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
          document.getElementById("chatStatus").textContent = "";
          document.getElementById("chatStatus").className = "pill";
          document.getElementById("chatMeta").innerHTML = "";
          document.getElementById("chatArea").innerHTML = '<div class="empty">没有匹配的数据。</div>';
          return;
        }
        document.getElementById("chatTitle").textContent = item.title;
        document.getElementById("chatSubtitle").textContent = item.sourceLabel + " / " + item.subtitle;
        document.getElementById("chatStatus").textContent = item.statusLabel || (item.pass ? "PASS" : "FAIL");
        document.getElementById("chatStatus").className = "pill " + (item.statusClass || (item.pass ? "good" : "bad"));
        document.getElementById("chatMeta").innerHTML = item.meta
          .filter((pair) => pair[1] !== undefined && pair[1] !== null && pair[1] !== "")
          .map((pair) => pill(pair[0] + ": " + pair[1]))
          .join("");
        document.getElementById("chatArea").innerHTML =
          '<div class="messages">' +
          '<section class="scene-panel"><strong>场景 scene</strong>' + esc(item.scene || "无场景文本") + '</section>' +
          item.messages.map(renderMessage).join("") +
          '<details class="detail-panel"><summary>judge / request meta / raw JSON</summary><pre>' + esc(JSON.stringify(item.detail, null, 2)) + '</pre></details>' +
          '</div>';
      }

      function pill(text) {
        return '<span class="pill">' + esc(text) + '</span>';
      }

      function renderMessage(message) {
        if (message.role === "round") {
          return '<div class="msg round"><div class="bubble">' + esc(message.label) + '</div></div>';
        }
        return '<div class="msg ' + esc(message.role) + '">' +
          '<div class="label">' + esc(message.label) + '</div>' +
          '<div class="bubble">' + esc(message.text) + '</div>' +
        '</div>';
      }

      function summaryText(value) {
        if (!value || typeof value !== "object") return String(value ?? "");
        return Object.entries(value).map(([key, item]) => key + ": " + JSON.stringify(item)).join("\\n");
      }

      function completedGames() {
        return (data.multiturn.games || []).filter((game) => game.completed).length;
      }

      searchEl.addEventListener("input", renderList);
      sourceEl.addEventListener("input", renderList);
      resultEl.addEventListener("input", renderList);
      toneEl.addEventListener("input", renderList);
      renderSummary();
      renderList();
    </script>
  </body>
</html>`;
}
