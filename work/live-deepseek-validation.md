# Live DeepSeek Validation

本文件用于 relationship-chat 的真实模型验证。它补充项目根目录 `AGENTS.md`，不覆盖其中的硬门槛。

## 验证模式

- `unit_fixture`：单元测试、mock、固定分数、确定性回归。只能标记为 fixture-backed。
- `local_api_smoke`：本地 HTTP API 基本请求验证。只能证明服务路径可用。
- `browser_ui`：Playwright 打开真实页面，填写可见输入框，点击可见发送按钮，等待 UI 更新。
- `live_external_service`：真实 DeepSeek 请求、真实评分、真实日志、真实服务器路径。

## Live DeepSeek 必查项

- `DEEPSEEK_API_KEY` 已加载。
- 没有设置 `RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE`。
- `/api/simulate` 走正常服务端路径，不用 route intercept。
- DeepSeek raw log 有本次请求和返回。
- 每个玩家尽量使用不同 `case_id`。
- 报告里区分浏览器玩家和 API 虚拟玩家。

## 浏览器玩家验收

- 使用 Playwright 真实打开 UI。
- 操作 visible textarea 和 visible send button。
- 等待 live DeepSeek-backed UI 更新。
- 至少保存一个完成后的截图、trace 或视频到 `output/playwright/`。
- 不用直接 HTTP 调用冒充浏览器玩家。
- 如果脚本点击页面里的 `recommended_reply_80` / 话术师填入按钮，这只能算浏览器通关烟测，不能算真人对话、训练数据或高质量 corpus。
- 浏览器通关烟测导入管理员看板时必须标明 `input_source=browser_visible_copywriter_fill_button`，并把 `browser_copywriter_loop` / `unsuitable_for_training_corpus` 计入 blockers。

## 真人模拟器 corpus 验收

- 适用于用户要“像两个人在聊天”“有价值的聊天”“数据集”“训练数据”“昨天那种数据”等任务。
- 每个 `user_reply` 必须由单独的 live DeepSeek human-player simulator 生成，再通过正常本地 HTTP `/api/session` 和 `/api/simulate` 送入关系模拟器。
- human-player simulator 只写下一句真人会发的中文回复；不得输出策略、建议、分数、解释，不得复制 `seed_recommended_reply`、上一轮 `recommended_reply_80`、`perfect_reply_100` 或历史用户回复。
- 训练质量 corpus 必须优先使用三层关系模型链路：`responseLayerMode=three_layer`。Target/Judge、Strategy Advisor、Copywriter 必须是三次独立 live DeepSeek 请求，输出里必须保留 `response_layer_mode`、`deepseek_layers` 和 `layer_outputs`。
- `/api/simulate` 请求必须带 `corpusTargetTurns=10`，除非危险、骚扰、威胁或明确无视拒绝，不允许第 10 轮前自然收尾。
- 输出 JSON 必须包含每轮 `input_source=live_deepseek_human_simulator`、`actual_user_reply`、`matched_deepseek_recommendation`、`deepseek_input`、`deepseek_output`、`request_contract`、`raw_response_meta` 和 `quality`。
- 如果任何一轮匹配上一轮推荐、满分答案、seed 推荐、重复用户输入、重复 target/recommended、缺少三层证据、建议提前收尾或裁判分数矛盾，最终 gate 必须是 FAIL；不能把这类数据当作合格训练样本。

## API 虚拟玩家验收

- 通过本地 HTTP `/api/session` 和 `/api/simulate`。
- 不用 direct import、direct function call、replayed JSON 或数据库插入冒充 API 玩家。
- 汇总 JSON 保存到 `output/`。

## 最终报告字段

- 验证模式：`unit_fixture` / `local_api_smoke` / `browser_ui` / `live_external_service`
- run mode：browser players 或 API virtual players
- player count
- completed game count
- request count
- failure count
- elapsed time
- 每个玩家的 `session_id`
- 每个玩家的 `case_id`
- final score distribution
- final title distribution
- duplicate-title explanation
- artifact paths：JSON、markdown、HTML、截图、视频、trace
- live DeepSeek 或 fixture-backed 的明确标签

## Blocker 处理

如果 DeepSeek 不可用、被限流、密钥缺失、服务路径错误、浏览器失败或 SQLite 锁异常：

1. 先定位最小本地问题。
2. 修复后只重跑受影响的验证线。
3. 如果仍被真实外部服务阻塞，停止并报告 blocker。
4. 不静默降级成 fixture 或 mock。
