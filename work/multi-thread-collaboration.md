# Multi-Thread Collaboration

本文件用于 relationship-chat 项目的多线程 / 多子任务协作。目标是并行提速，但不让多个线程互相覆盖、重复验证或把证据混在一起。

## 什么时候值得多线程

- 同时需要改 UI、API、数据脚本、报告页面。
- 同时需要跑浏览器玩家和 API 虚拟玩家。
- 一个线程做实现，另一个线程做只读 review 或 verification。
- 需要分别检查本地代码、线上日志、DeepSeek raw log、SQLite 状态。

不值得多线程的场景：

- 只改一个小文案或单文件 bug。
- 下一步依赖前一步结论，无法真正并行。
- 多个线程都会改同一个核心文件。

## 推荐线程划分

### UI 线程

负责：

- `web/relationship-chat/**`
- 页面交互、按钮状态、HUD、数据看板展示
- Playwright 浏览器截图或录屏

不要负责：

- DeepSeek prompt / judge contract
- SQLite schema
- 后端评分公式

### API / Server 线程

负责：

- `scripts/relationship-chat-server.ts`
- `/api/session`
- `/api/simulate`
- DeepSeek 调用路径、错误处理、日志写入

不要负责：

- 页面视觉重排
- 大批量输出 artifact 清理

### Data / Runner 线程

负责：

- `scripts/run-*.ts`
- `scripts/build-*.ts`
- `data/**`
- `output/**`
- API 虚拟玩家、语料生成、报告汇总

不要负责：

- 改 UI 主交互
- 改 DeepSeek 评分契约，除非任务明确要求

### Review / Verification 线程

负责：

- 只读检查 diff
- 跑 `npm test`、`npm run typecheck`
- 检查 artifact 是否能证明结论
- 区分 fixture、browser-ui、live-external-service

不要负责：

- 在 review 过程中顺手改代码
- 用单一证据线替代另一条证据线

## 文件边界规则

- 每个线程开始前写清楚 `allowed_files` 和 `forbidden_files`。
- 同一时间只有一个线程可以改同一个核心文件。
- `scripts/relationship-chat-game.ts`、`scripts/relationship-chat-server.ts`、`web/relationship-chat/app.js` 属于高冲突文件，默认串行修改。
- `docs/deepseek-games/**`、`output/**` 是证据产物，不能拿来证明另一个未执行的验证线。
- `.env`、密钥、生产凭证永远禁止修改或提交。

## 并行验证规则

浏览器玩家和 API 虚拟玩家可以并行跑，但结论必须分开写：

- browser players：真实页面、真实输入框、真实发送按钮、可见 UI 完成。
- API virtual players：真实 HTTP `/api/session` 和 `/api/simulate`。

不能这样写：

- “API 跑通了，所以浏览器玩家也通过。”
- “浏览器录屏成功，所以 50 个 API 虚拟玩家也完成。”
- “fixture 测试通过，所以 live DeepSeek 数据可用。”

## 多线程最终汇总格式

每个线程回报时必须包含：

- 线程名称
- 负责范围
- 改动文件
- 验证模式
- 命令和结果
- 证据路径
- blocker 或剩余风险

总线程最终汇总时必须包含：

- 哪些线程完成
- 哪些线程未完成或被阻塞
- browser-ui 证据和 API 证据是否分别成立
- live DeepSeek 是否真实使用
- 是否有文件冲突、SQLite lock、DeepSeek rate limit 或旧进程干扰

## 最短启动句式

```text
开始目标: 多线程完成【目标】，直接做完
```

如果需要明确拆分：

```text
开始目标: 多线程完成【目标】。UI、API、跑数、验证分开做，最后汇总证据。
```
