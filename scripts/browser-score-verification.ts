import { mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const outputDir = resolve("output", "playwright", "score-verification");
const port = Number(process.env.RELATIONSHIP_CHAT_VERIFY_PORT ?? "5198");
const baseUrl = `http://127.0.0.1:${port}/`;
mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE: "45_TO_55",
    CHAT_DB_FILE: join(process.cwd(), ".cache", "relationship-chat-e2e.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 150));
    }
  }
  throw new Error(`验证服务没有启动：${serverOutput}`);
}

async function waitForHud(page: Page, totalScore: string, previousRoundScore: string) {
  await page.waitForFunction(
    (scores: { total: string; previous: string }) =>
      document.querySelector("#totalScore")?.textContent === scores.total &&
      document.querySelector("#previousRoundScore")?.textContent === scores.previous &&
      document.querySelector("#statusText")?.textContent !== "模拟完成",
    { total: totalScore, previous: previousRoundScore },
    { timeout: 8_000 },
  );
}

async function sendReply(page: Page, text: string, totalScore: string, previousRoundScore: string) {
  await page.fill("#replyInput", text);
  await page.click("#sendButton");
  await waitForHud(page, totalScore, previousRoundScore);
}

function convertVideoToMp4(videoPath: string | null, outputName: string) {
  if (!videoPath) return null;
  const outputPath = join(outputDir, outputName);
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath],
    { encoding: "utf8" },
  );
  return result.status === 0 ? outputPath : null;
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: {
      dir: outputDir,
      size: { width: 390, height: 844 },
    },
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#replyInput", { timeout: 8_000 });

  await sendReply(page, "第 1 轮：尊重你的节奏，我慢慢来。", "+12", "+12");
  await sendReply(page, "第 2 轮：我不会逼你现在回答。", "+24", "+12");
  await sendReply(page, "第 3 轮：你舒服一点更重要。", "+36", "+12");
  await sendReply(page, "第 4 轮：我继续放轻，不急。", "+45", "+9");
  await sendReply(page, "第 5 轮：45 分后继续满分验证。", "+55", "+10");

  const screenshot = join(outputDir, "score-45-to-55-real-server.png");
  await page.screenshot({ path: screenshot, fullPage: true });

  const statusText = await page.locator("#statusText").textContent();
  const totalScore = await page.locator("#totalScore").textContent();
  const previousRoundScore = await page.locator("#previousRoundScore").textContent();

  await context.close();
  await browser.close();

  const videos = readdirSync(outputDir)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => join(outputDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const video = videos[0] ?? null;
  const mp4Video = convertVideoToMp4(video, "score-45-to-55-real-server.mp4");

  console.log(
    JSON.stringify(
      {
        url: baseUrl,
        totalScore,
        previousRoundScore,
        statusText,
        screenshot,
        video,
        mp4Video,
        exercised: ["browser UI", "HTTP /api/simulate", "server applyGameRound", "HUD render"],
      },
      null,
      2,
    ),
  );
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  server.kill("SIGTERM");
}
