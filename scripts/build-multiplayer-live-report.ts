import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";

type ApiPlayer = {
  player_id: string;
  mode: string;
  session_id: string | null;
  visitor_id: string;
  case_id: string;
  stage: string;
  completed: boolean;
  error: string | null;
  request_count: number;
  final_score: number | null;
  final_title: string | null;
  turn_count: number;
  completion_reason: string | null;
  elapsed_ms: number | null;
};

type BrowserPlayer = {
  id: string;
  mode: string;
  base_url: string;
  case_clicks: number;
  completed: boolean;
  error: string | null;
  rounds_attempted: number;
  final_score: number | null;
  final_title: string | null;
  scene_excerpt: string | null;
  screenshot: string | null;
  video: string | null;
  events: Array<{
    round: number;
    elapsed_ms: number;
    score_text: string;
    settlement_visible: boolean;
  }>;
  settlement_excerpt?: string;
  body_excerpt?: string;
};

type RunSummary<TPlayer> = {
  mode: string;
  base_url: string;
  player_count: number;
  completed_game_count: number;
  failure_count: number;
  request_count: number;
  elapsed_ms: number;
  title_distribution: Record<string, number>;
  score_distribution?: Record<string, number>;
  players: TPlayer[];
};

const apiSummaryPath = "output/multiplayer-api-50-live-summary.json";
const browserSummaryPath = "output/playwright/multiplayer-live/browser-players-summary.json";
const outputPath = "output/multiplayer-live-report.html";

const apiSummary = readJson<RunSummary<ApiPlayer>>(apiSummaryPath);
const browserSummary = readJson<RunSummary<BrowserPlayer>>(browserSummaryPath);
const reportData = normalizeReportData(apiSummary, browserSummary);

writeFileSync(outputPath, buildHtml(reportData), "utf8");
console.log(`Wrote ${outputPath}`);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizeReportData(api: RunSummary<ApiPlayer>, browser: RunSummary<BrowserPlayer>) {
  return {
    generated_at: new Date().toISOString(),
    source_files: {
      api: apiSummaryPath,
      browser: browserSummaryPath,
    },
    api,
    browser: {
      ...browser,
      players: browser.players.map((player) => ({
        ...player,
        screenshot_relative: mediaRelativePath(player.screenshot),
        video_relative: mediaRelativePath(player.video),
      })),
    },
  };
}

function mediaRelativePath(path: string | null) {
  if (!path) return null;
  return relative("output", path).split("/").map(encodeURIComponent).join("/");
}

function buildHtml(data: ReturnType<typeof normalizeReportData>) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>多玩家 Live DeepSeek 数据看板</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f8;
        --ink: #14171a;
        --muted: #69727d;
        --line: #d8dde3;
        --surface: #ffffff;
        --accent: #0f8b8d;
        --accent-2: #d95d39;
        --good: #197b55;
        --bad: #b42318;
        --warn: #9a6700;
        --shadow: 0 12px 34px rgba(28, 35, 43, 0.08);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      button, input, select {
        font: inherit;
      }
      button {
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        cursor: pointer;
      }
      .shell {
        min-height: 100svh;
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px clamp(16px, 4vw, 44px);
        border-bottom: 1px solid var(--line);
        background: rgba(246, 247, 248, 0.94);
        backdrop-filter: blur(12px);
      }
      .brand {
        display: grid;
        gap: 2px;
      }
      .brand strong {
        font-size: 18px;
      }
      .brand span, .meta-line {
        color: var(--muted);
        font-size: 12px;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .tabs button, .filters button {
        min-height: 34px;
        border-radius: 6px;
        padding: 0 12px;
      }
      .tabs button.active, .filters button.active {
        background: var(--ink);
        color: #fff;
        border-color: var(--ink);
      }
      main {
        padding: 28px clamp(16px, 4vw, 44px) 52px;
      }
      .overview {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: clamp(18px, 3vw, 34px);
        align-items: start;
      }
      .headline {
        display: grid;
        gap: 18px;
        padding: clamp(22px, 4vw, 42px) 0;
      }
      h1 {
        margin: 0;
        max-width: 900px;
        font-size: clamp(34px, 6vw, 76px);
        line-height: 0.98;
      }
      .summary-text {
        max-width: 760px;
        color: #3f4852;
        font-size: clamp(15px, 2vw, 18px);
        line-height: 1.75;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }
      .kpi {
        display: grid;
        gap: 8px;
        min-height: 108px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .kpi span {
        color: var(--muted);
        font-size: 12px;
      }
      .kpi strong {
        font-size: clamp(24px, 3vw, 36px);
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
      }
      .panel-header h2, .section-title h2 {
        margin: 0;
        font-size: 18px;
      }
      .panel-body {
        padding: 16px 18px;
      }
      .bar-list {
        display: grid;
        gap: 10px;
      }
      .bar-row {
        display: grid;
        grid-template-columns: minmax(120px, 1fr) 5fr auto;
        align-items: center;
        gap: 10px;
        min-height: 28px;
      }
      .bar-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bar-track {
        height: 10px;
        overflow: hidden;
        border-radius: 999px;
        background: #e7eaee;
      }
      .bar-fill {
        height: 100%;
        min-width: 2px;
        background: var(--accent);
        transform-origin: left center;
        animation: grow 700ms ease both;
      }
      .bar-fill.alt {
        background: var(--accent-2);
      }
      @keyframes grow {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }
      .section {
        display: grid;
        gap: 16px;
        margin-top: 30px;
      }
      .section-title {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 12px;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .filters input, .filters select {
        min-height: 34px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 0 10px;
        background: #fff;
      }
      .table-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      table {
        width: 100%;
        min-width: 980px;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        font-size: 13px;
      }
      th {
        position: sticky;
        top: 62px;
        z-index: 5;
        background: #eef2f4;
        color: #2d353d;
        font-weight: 700;
      }
      tr:hover td {
        background: #f8fafb;
      }
      .status {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        color: #fff;
        font-size: 12px;
        background: var(--good);
      }
      .status.bad {
        background: var(--bad);
      }
      .score {
        font-weight: 800;
      }
      .score.good { color: var(--good); }
      .score.bad { color: var(--bad); }
      .media-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
      }
      .media-item {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .media-item img, .media-item video {
        width: 100%;
        max-height: 420px;
        object-fit: contain;
        border-radius: 6px;
        background: #111;
      }
      details {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      summary {
        padding: 14px 16px;
        cursor: pointer;
        font-weight: 700;
      }
      pre {
        max-height: 520px;
        margin: 0;
        overflow: auto;
        padding: 16px;
        border-top: 1px solid var(--line);
        background: #101418;
        color: #e8f0f2;
        font-size: 12px;
        line-height: 1.55;
      }
      .hidden { display: none !important; }
      @media (max-width: 860px) {
        .topbar, .section-title, .overview {
          grid-template-columns: 1fr;
          display: grid;
        }
        .kpi-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .bar-row {
          grid-template-columns: 1fr auto;
        }
        .bar-track {
          grid-column: 1 / -1;
        }
        th {
          top: 114px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <strong>多玩家 Live DeepSeek 数据看板</strong>
          <span id="freshness"></span>
        </div>
        <nav class="tabs" aria-label="看板导航">
          <button type="button" data-jump="overview">概览</button>
          <button type="button" data-jump="api">API 50 玩家</button>
          <button type="button" data-jump="browser">浏览器 5 玩家</button>
          <button type="button" data-jump="media">截图视频</button>
          <button type="button" data-jump="raw">原始 JSON</button>
        </nav>
      </header>

      <main>
        <section id="overview" class="overview">
          <div class="headline">
            <h1>所有 live 跑数集中在这一页</h1>
            <p class="summary-text">
              页面汇总 API 虚拟玩家、Playwright 真实浏览器玩家、称号分布、分数区间、逐玩家明细、UI 截图和录屏。所有数据来自本地输出文件，不包含 fixture 或 mock 标记。
            </p>
            <div id="kpis" class="kpi-grid"></div>
          </div>
          <div class="panel">
            <div class="panel-header">
              <h2>称号分布</h2>
              <span class="meta-line">API 与浏览器合并视图</span>
            </div>
            <div class="panel-body">
              <div id="combinedTitleBars" class="bar-list"></div>
            </div>
          </div>
        </section>

        <section id="api" class="section">
          <div class="section-title">
            <div>
              <h2>API 50 虚拟玩家</h2>
              <p class="meta-line">真实 HTTP 调用 /api/session 与 /api/simulate。</p>
            </div>
            <div class="filters">
              <input id="apiSearch" type="search" placeholder="搜索 session、case、称号" />
              <select id="apiStageFilter"></select>
              <select id="apiStatusFilter">
                <option value="">全部状态</option>
                <option value="done">完成</option>
                <option value="failed">失败</option>
              </select>
            </div>
          </div>
          <div class="panel">
            <div class="panel-header">
              <h2>API 分数区间</h2>
              <span class="meta-line" id="apiMeta"></span>
            </div>
            <div class="panel-body">
              <div id="apiScoreBars" class="bar-list"></div>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>状态</th>
                  <th>case / 阶段</th>
                  <th>分数 / 称号</th>
                  <th>轮数 / 请求</th>
                  <th>耗时</th>
                  <th>session</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody id="apiRows"></tbody>
            </table>
          </div>
        </section>

        <section id="browser" class="section">
          <div class="section-title">
            <div>
              <h2>Playwright 5 真实浏览器玩家</h2>
              <p class="meta-line">真实打开页面、进入设置换场景、填写 textarea、点击发送、等待 live DeepSeek UI 结算。</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>状态</th>
                  <th>分数 / 称号</th>
                  <th>轮数</th>
                  <th>每轮等待</th>
                  <th>截图 / 视频</th>
                  <th>结算摘录</th>
                </tr>
              </thead>
              <tbody id="browserRows"></tbody>
            </table>
          </div>
        </section>

        <section id="media" class="section">
          <div class="section-title">
            <div>
              <h2>浏览器证据</h2>
              <p class="meta-line">每个玩家最终截图和录屏。截图可直接打开原文件。</p>
            </div>
          </div>
          <div id="mediaGrid" class="media-grid"></div>
        </section>

        <section id="raw" class="section">
          <div class="section-title">
            <div>
              <h2>原始数据</h2>
              <p class="meta-line">看板嵌入的完整 JSON，方便核对所有字段。</p>
            </div>
          </div>
          <details>
            <summary>API summary JSON</summary>
            <pre id="rawApi"></pre>
          </details>
          <details>
            <summary>Browser summary JSON</summary>
            <pre id="rawBrowser"></pre>
          </details>
        </section>
      </main>
    </div>
    <script id="reportData" type="application/json">${json}</script>
    <script>
      const data = JSON.parse(document.getElementById("reportData").textContent);
      const api = data.api;
      const browser = data.browser;
      const byId = (id) => document.getElementById(id);
      const fmtMs = (ms) => {
        if (ms === null || ms === undefined) return "-";
        if (ms < 1000) return ms + "ms";
        return (ms / 1000).toFixed(1) + "s";
      };
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
      const scoreClass = (score) => Number(score) < 0 ? "bad" : Number(score) >= 31 ? "good" : "";
      const statusPill = (ok) => '<span class="status ' + (ok ? "" : "bad") + '">' + (ok ? "完成" : "失败") + "</span>";

      document.getElementById("freshness").textContent = "生成时间 " + new Date(data.generated_at).toLocaleString();
      document.querySelectorAll("[data-jump]").forEach((button) => {
        button.addEventListener("click", () => {
          document.querySelectorAll("[data-jump]").forEach((item) => item.classList.toggle("active", item === button));
          document.getElementById(button.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      function renderKpis() {
        const values = [
          ["API 玩家", api.player_count, api.completed_game_count + " 完成 / " + api.failure_count + " 失败"],
          ["API 请求", api.request_count, "耗时 " + fmtMs(api.elapsed_ms)],
          ["浏览器玩家", browser.player_count, browser.completed_game_count + " 完成 / " + browser.failure_count + " 失败"],
          ["浏览器 UI 请求", browser.request_count, "耗时 " + fmtMs(browser.elapsed_ms)],
          ["API 称号种类", Object.keys(api.title_distribution).length, "最高重复 " + maxEntry(api.title_distribution).join(" x")],
          ["浏览器称号种类", Object.keys(browser.title_distribution).length, "5 个玩家 UI 证据"],
          ["数据模式", "Live", api.mode + " / " + browser.mode],
          ["源文件", "2", basename(data.source_files.api) + " + " + basename(data.source_files.browser)],
        ];
        byId("kpis").innerHTML = values.map(([label, value, hint]) => '<div class="kpi"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><span>' + esc(hint) + '</span></div>').join("");
      }

      function basename(path) {
        return String(path).split("/").at(-1);
      }

      function maxEntry(obj) {
        const entries = Object.entries(obj);
        if (!entries.length) return ["-", 0];
        return entries.sort((a, b) => b[1] - a[1])[0];
      }

      function renderBars(id, obj, variant = "") {
        const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
        const max = Math.max(1, ...entries.map(([, value]) => value));
        byId(id).innerHTML = entries.map(([label, value]) => {
          const width = Math.max(4, Math.round((value / max) * 100));
          return '<div class="bar-row"><span class="bar-label" title="' + esc(label) + '">' + esc(label) + '</span><div class="bar-track"><div class="bar-fill ' + variant + '" style="width:' + width + '%"></div></div><strong>' + value + '</strong></div>';
        }).join("");
      }

      function renderApiFilters() {
        const stages = Array.from(new Set(api.players.map((player) => player.stage))).sort();
        byId("apiStageFilter").innerHTML = '<option value="">全部阶段</option>' + stages.map((stage) => '<option value="' + esc(stage) + '">' + esc(stage) + '</option>').join("");
        ["apiSearch", "apiStageFilter", "apiStatusFilter"].forEach((id) => byId(id).addEventListener("input", renderApiRows));
      }

      function renderApiRows() {
        const search = byId("apiSearch").value.trim().toLowerCase();
        const stage = byId("apiStageFilter").value;
        const status = byId("apiStatusFilter").value;
        const rows = api.players.filter((player) => {
          const haystack = [player.player_id, player.session_id, player.case_id, player.stage, player.final_title, player.error].join(" ").toLowerCase();
          if (search && !haystack.includes(search)) return false;
          if (stage && player.stage !== stage) return false;
          if (status === "done" && !player.completed) return false;
          if (status === "failed" && player.completed) return false;
          return true;
        });
        byId("apiRows").innerHTML = rows.map((player) => '<tr>' +
          '<td><strong>' + esc(player.player_id) + '</strong><br><span class="meta-line">' + esc(player.visitor_id) + '</span></td>' +
          '<td>' + statusPill(player.completed) + '</td>' +
          '<td><strong>' + esc(player.case_id) + '</strong><br><span class="meta-line">' + esc(player.stage) + '</span></td>' +
          '<td><span class="score ' + scoreClass(player.final_score) + '">' + esc(player.final_score) + '</span><br>' + esc(player.final_title) + '</td>' +
          '<td>' + esc(player.turn_count) + ' 轮<br><span class="meta-line">' + esc(player.request_count) + ' 请求</span></td>' +
          '<td>' + fmtMs(player.elapsed_ms) + '</td>' +
          '<td><span class="meta-line">' + esc(player.session_id) + '</span></td>' +
          '<td>' + esc(player.error ?? "") + '</td>' +
        '</tr>').join("");
      }

      function renderBrowserRows() {
        byId("browserRows").innerHTML = browser.players.map((player) => {
          const events = player.events.map((event) => "第" + event.round + "轮 " + fmtMs(event.elapsed_ms) + " " + event.score_text).join("<br>");
          const media = [
            player.screenshot_relative ? '<a href="' + esc(player.screenshot_relative) + '" target="_blank">截图</a>' : "",
            player.video_relative ? '<a href="' + esc(player.video_relative) + '" target="_blank">视频</a>' : "",
          ].filter(Boolean).join(" / ");
          return '<tr>' +
            '<td><strong>' + esc(player.id) + '</strong><br><span class="meta-line">换场景 ' + esc(player.case_clicks) + ' 次</span></td>' +
            '<td>' + statusPill(player.completed) + '</td>' +
            '<td><span class="score ' + scoreClass(player.final_score) + '">' + esc(player.final_score) + '</span><br>' + esc(player.final_title) + '</td>' +
            '<td>' + esc(player.rounds_attempted) + '</td>' +
            '<td>' + events + '</td>' +
            '<td>' + media + '</td>' +
            '<td>' + esc(player.settlement_excerpt || player.error || "").slice(0, 380) + '</td>' +
          '</tr>';
        }).join("");
      }

      function renderMedia() {
        byId("mediaGrid").innerHTML = browser.players.map((player) => '<article class="media-item">' +
          '<strong>' + esc(player.id) + ' · ' + esc(player.final_title) + '</strong>' +
          '<span class="meta-line">' + esc(player.final_score) + ' 分 · ' + esc(player.rounds_attempted) + ' 轮</span>' +
          (player.screenshot_relative ? '<a href="' + esc(player.screenshot_relative) + '" target="_blank"><img src="' + esc(player.screenshot_relative) + '" alt="' + esc(player.id) + ' final screenshot" loading="lazy" /></a>' : '') +
          (player.video_relative ? '<video src="' + esc(player.video_relative) + '" controls preload="metadata"></video>' : '') +
        '</article>').join("");
      }

      function mergeDistributions(...objects) {
        return objects.reduce((acc, obj) => {
          Object.entries(obj).forEach(([key, value]) => {
            acc[key] = (acc[key] || 0) + value;
          });
          return acc;
        }, {});
      }

      renderKpis();
      renderBars("combinedTitleBars", mergeDistributions(api.title_distribution, browser.title_distribution));
      renderBars("apiScoreBars", api.score_distribution || {}, "alt");
      byId("apiMeta").textContent = api.completed_game_count + "/" + api.player_count + " 完成，" + api.request_count + " 次请求";
      renderApiFilters();
      renderApiRows();
      renderBrowserRows();
      renderMedia();
      byId("rawApi").textContent = JSON.stringify(api, null, 2);
      byId("rawBrowser").textContent = JSON.stringify(browser, null, 2);
    </script>
  </body>
</html>`;
}
