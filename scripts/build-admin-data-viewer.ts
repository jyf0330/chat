import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const sourceJsonPath = process.argv[2] ?? "output/deepseek-50x10-live/deepseek-50x10-live.json";
const outputHtmlPath = process.argv[3] ?? "output/deepseek-50x10-live/admin-data-viewer.html";
const templatePath = "web/relationship-chat/admin-data-viewer.html";

const template = readFileSync(templatePath, "utf8");
const sourceJson = readFileSync(sourceJsonPath, "utf8").replace(/</g, "\\u003c");
const embedScript = `<script>window.__DEEPSEEK_ADMIN_SOURCE__=${JSON.stringify(sourceJsonPath)};window.__DEEPSEEK_ADMIN_DATA__=${sourceJson};</script>`;
const html = template.replace("<script>\n      const state = {", `${embedScript}\n    <script>\n      const state = {`);

mkdirSync(dirname(outputHtmlPath), { recursive: true });
writeFileSync(outputHtmlPath, html, "utf8");

console.log(`Wrote ${outputHtmlPath} from ${sourceJsonPath}`);
