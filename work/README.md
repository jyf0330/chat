# Relationship Chat Work Notes

这个文件夹只保存对本项目有用的轻量工作流，不复制桌面 `work/` 的通用大流程。

## 适用场景

- 跑真实 DeepSeek 游戏数据
- 做 Playwright 浏览器录屏或截图验证
- 做 API 虚拟玩家并发验证
- 排查线上 DeepSeek 日志、评分、称号、结束条件异常
- 拆分多人或多线程任务时固定文件边界和验收标准

## 核心原则

1. 用户可见的 gameplay、跑数、录屏、截图、并发验证默认必须走 live DeepSeek。
2. `fixture`、mock、deterministic regression 只能当测试，不能当真实数据交付。
3. 浏览器玩家和 API 虚拟玩家是两条验证线，不能互相替代。
4. 每个任务先写清楚允许改哪些文件、禁止改哪些文件、怎么验收。
5. 最终报告必须包含证据路径、验证模式、玩家数或请求数、失败数、分数/称号分布和剩余风险。

## 文件

- `live-deepseek-validation.md`：真实 DeepSeek 验证任务清单。
- `multi-thread-collaboration.md`：多线程 / 多子任务拆分、文件边界和汇总规则。
- `task-packet-template.yaml`：给后续任务拆分用的轻量任务包模板。

## 最短可用句式

```text
开始目标: 你的目标
```

如果要我直接做到验证完成：

```text
开始目标: 你的目标，直接做完
```

如果涉及真实 DeepSeek、录屏、跑数、线上日志或多人验证，执行前先对照 `live-deepseek-validation.md`。
