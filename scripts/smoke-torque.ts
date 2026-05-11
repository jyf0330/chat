import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { assistant, generateDataset, metadata, system, user } from "@qforge/torque";
import { openai } from "@ai-sdk/openai";

const output = "data/torque-smoke.jsonl";

await mkdir(dirname(output), { recursive: true });

await generateDataset(
  () => [
    metadata({
      fixture: "torque_install_smoke",
      relationship_stage: "暧昧初期",
      target_emotion: "疲惫",
      risk_level: "medium",
    }),
    system({ content: "Static smoke test for Torque installation." }),
    user({ content: "最近真的有点累，改天再说吧。" }),
    assistant({
      content:
        "那你先好好休息，别硬撑。等你缓过来我们再聊，我不催你。",
    }),
  ],
  {
    count: 2,
    seed: 20260510,
    model: openai(process.env.TORQUE_MODEL ?? "gpt-4o-mini"),
    output,
  },
);

console.log(`Torque smoke dataset written to ${output}`);
