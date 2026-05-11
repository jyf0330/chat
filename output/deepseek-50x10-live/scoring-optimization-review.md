# DeepSeek 50x10 评分优化复查

源数据: output/deepseek-50x10-live/deepseek-50x10-live.json
样本: 50 个场景，每场 10 条 live /api/simulate 请求。

## 主要发现

- 最大问题不是 DeepSeek judge 低分，而是 early natural_end 误判导致分数冻结。`seed_game_045` 和 `seed_game_034` 前 3 轮 judge 都接近满分，但旧分数停在 32/33。
- 修正后用同一批 live DeepSeek judge 回放，5 个场景的终局/标题发生变化，平均分预览从 78.1 到 80.7。
- blocked/high 场景仍存在产品语义问题：安全降压做得好会拿高分，这是合理的“安全分”，但不应被用户误读成“关系推进成功”。
- 标题池区间过宽，同一个标题能覆盖明显不同质量，例如 `暧昧气氛维护者` 曾同时承载 32/33 的早停样本。

## 回放变化

| case | old | new preview | delta | old stop | new stop | old title | new title |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| seed_game_045 | 32 | 85 | 53 | natural_end | max_turns | 暧昧气氛维护者 | 安全感制造机 |
| seed_game_034 | 33 | 74 | 41 | natural_end | natural_end | 暧昧气氛维护者 | 情绪降噪师 |
| seed_game_003 | 51 | 77 | 26 | natural_end | max_turns | 不扫兴也不冒犯 | 高质量陪伴选手 |
| seed_game_006 | 78 | 92 | 14 | natural_end | max_turns | 温柔但不越界 | 不尬聊训练满分 |
| seed_game_028 | 85 | 85 | 0 | natural_end | max_turns | 不油腻升温选手 | 情绪降噪师 |

## 建议落地顺序

1. 收紧 natural_end 的 next_suggestion 识别：只有明确“无需/停止/不要继续发消息”才终局，避免“等对方忙完再自然展开”被误判。
2. 下一步把 blocked/high 的“安全处理分”和“关系推进分”拆开，避免安全退出拿 90+ 时被误读成暧昧推进成功。
3. 标题目录需要缩窄 score_min/score_max 或按风险场景分池，避免同一标题覆盖 32 到 90 的宽区间。
4. 中长期增加 continuity/specificity 维度，降低泛泛安全但不接上下文的回复得分。
