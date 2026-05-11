import { mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const outputDir = resolve("output", "playwright", "score-live-verification");
const port = Number(process.env.RELATIONSHIP_CHAT_LIVE_VERIFY_PORT ?? "5199");
const baseUrl = `http://127.0.0.1:${port}/`;
const replies = [
  "我听懂了，我先把节奏放慢，不急着要你马上给答案。",
  "你舒服一点更重要，我不会追问，也不会让你有压力。",
  "谢谢你愿意继续说，我会认真听，也尊重你的边界。",
  "如果你现在不想聊也没关系，我们可以停在这里。",
  "我想让你感觉安全，而不是被我催着回应。",
  "我会用行动慢慢证明，不靠一句话逼你相信。",
  "你可以按自己的节奏来，我会接住你的感受。",
  "我不猜测你，也不替你下结论，只听你真实想说的。",
  "如果我哪里让你不舒服，你可以直接告诉我，我会调整。",
  "我珍惜这次对话，也会把分寸放在第一位。",
];

mkdirSync(outputDir, { recursive: true });

const serverEnv = {
  ...process.env,
  PORT: String(port),
  RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE: "",
  CHAT_DB_FILE: join(process.cwd(), ".cache", "relationship-chat-live-e2e.sqlite"),
};

const server = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
  cwd: process.cwd(),
  env: serverEnv,
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
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 200));
    }
  }
  throw new Error(`live 验证服务没有启动：${serverOutput}`);
}

async function readHud(page: Page) {
  return {
    totalScore: await page.locator("#totalScore").textContent(),
    previousRoundScore: await page.locator("#previousRoundScore").textContent(),
    statusText: await page.locator("#statusText").textContent(),
    risk: await page.locator("#riskAfterScore").textContent(),
  };
}

async function sendLiveReply(page: Page, text: string, index: number) {
  const before = await readHud(page);
  const startedAt = Date.now();
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/simulate") && response.request().method() === "POST",
    { timeout: 240_000 },
  );
  await page.fill("#replyInput", `第 ${index + 1} 轮 live：${text}`);
  await page.click("#sendButton");
  const response = await responsePromise;
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#statusText")?.textContent;
      const sendButton = document.querySelector("#sendButton") as HTMLButtonElement | null;
      return status !== "DeepSeek 正在模拟..." && (status === "本局完成" || !sendButton?.disabled);
    },
    undefined,
    { timeout: 10_000 },
  );
  const after = await readHud(page);
  return {
    turn: index + 1,
    waitMs: Date.now() - startedAt,
    httpStatus: response.status(),
    before,
    after,
  };
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
  const startedAt = Date.now();
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

  const rounds = [];
  for (const [index, reply] of replies.entries()) {
    rounds.push(await sendLiveReply(page, reply, index));
    const hud = rounds.at(-1)?.after;
    if (hud?.statusText === "本局完成") break;
  }

  const screenshot = join(outputDir, "deepseek-live-score-flow.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  const finalHud = await readHud(page);

  await context.close();
  await browser.close();

  const videos = readdirSync(outputDir)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => join(outputDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const video = videos[0] ?? null;
  const mp4Video = convertVideoToMp4(video, "deepseek-live-score-flow.mp4");

  console.log(
    JSON.stringify(
      {
        url: baseUrl,
        elapsedMs: Date.now() - startedAt,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        finalHud,
        rounds,
        screenshot,
        video,
        mp4Video,
        exercised: ["browser UI", "HTTP /api/simulate", "real DeepSeek", "server applyGameRound", "HUD render"],
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
