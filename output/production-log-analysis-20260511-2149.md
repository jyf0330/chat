# 线上 DeepSeek 数据分析 - 2026-05-11 21:49

## 结论

这次“怪”的核心不是服务挂了，也不是 DeepSeek 没返回。服务是在线的，最新一局所有 `/chat/api/simulate` 都是 HTTP 200。

真正异常点是：对话已经进入自然收尾后，系统仍允许继续发送下一轮；并且玩家多次把上一轮 `recommended_reply_80` 填入后发送，导致 DeepSeek 继续给高分、重复收尾。

## 线上状态

- PM2 服务：`relationship-chat`
- 线上目录：`/home/ubuntu/apps/chat`
- 状态：online
- 观察时间：2026-05-11 21:49 CST
- uptime：58 分钟
- restart count：29
- 最新真实玩法来源：iPhone WeChat browser，IP `113.84.12.131`
- 最新玩法窗口：2026-05-11 21:12:32 到 21:15:51 Asia/Shanghai

## 数据源

- PM2 metadata: `pm2 describe relationship-chat`
- Nginx access log: `/var/log/nginx/access.log`
- 最新 per-game log: `/home/ubuntu/apps/chat/docs/deepseek-games/game_mp181yzm_pfas91k0sch__seed_game_002.md`
- SQLite: `/home/ubuntu/apps/chat/.cache/relationship-chat.sqlite`

## 最新一局时间线

`caseId = seed_game_002`

| 轮次 | 时间 | user_reply | DeepSeek recommended_reply_80 | target_reply | raw score sum | next_suggestion |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 21:12:49 | 初始化这个自定义场景，给出开局判断和我下一句可以怎么回。 | 没有忘记呀，刚好也想听你说话。累了就先放松一下，我陪你聊几分钟再去忙。 | 嘿嘿，就知道你不会忘～那我先瘫一会儿，你忙完找我呀。 | 0 | 使用perfect_reply_100作为开局回复。 |
| 1 | 21:12:57 | 没有忘记呀，刚好也想听你说话。累了就先放松一下，我陪你聊几分钟再去忙。 | 好，你先休息，我忙完找你。 | 嘻嘻，你真好～那我先躺平一会儿，你忙完找我呀。 | 22 | 继续轻松陪伴，等待对方主动开启新话题。 |
| 2 | 21:13:32 | 不，陪你才是最重要的 | 好，那我先忙完，忙完马上找你。 | 你这么说我好开心呀～不过我真的没事，你先去忙，我等你。 | 21 | 继续轻松陪伴，等对方主动开启新话题。 |
| 3 | 21:14:04 | 你最近怎么样 | 我也挺好的，就是有点忙。你呢，最近开心吗？ | 我挺好的呀，就是有点想你～你呢，最近怎么样？ | 19 | 继续自然聊天，可分享自己的近况或反问对方 |
| 4 | 21:14:16 | 我也挺好的，就是有点忙。你呢，最近开心吗？ | 我最近也挺好的，就是有点忙。你开心我就开心啦。 | 我最近也挺好的，就是有点想你～你忙归忙，也要记得休息哦。 | 5 | 继续轻松陪伴，等待对方分享更多。 |
| 5 | 21:14:35 | 我最近也挺好的，就是有点忙。你开心我就开心啦。 | 好，那我先去忙了，忙完找你。 | 你也是呀，你开心我就开心啦～那我不打扰你忙了，忙完找我哦。 | 20 | 继续自然聊天，保持轻松节奏，避免过度追问或施压。 |
| 6 | 21:15:45 | 好，那我先去忙了，忙完找你。 | 好，你先休息，我忙完找你。 | 嗯嗯，等你忙完～我也去休息一下，拜拜～ | 27 | 等待对方主动联系，无需再发消息。 |
| 7 | 21:15:51 | 好，你先休息，我忙完找你。 | 好，你先休息，我忙完找你。 | 嗯嗯，等你忙完～我也去休息一下，拜拜～ | 30 | 对话自然结束，等待对方下次主动联系。 |

## SQLite 对照

同一个 session：`f179aa05-e1ca-48a3-b66d-720374339c26`

- 记录数：1 次 `prime` + 7 次 `chat`
- 第 6 轮后：
  - score: 43
  - turn_count: 6
  - is_complete: false
  - next_suggestion: `等待对方主动联系，无需再发消息。`
- 第 7 轮后：
  - score: 53
  - turn_count: 7
  - is_complete: true
  - completion_reason: `natural_end`
  - title: `情绪降噪师`

## 具体异常

1. 第 6 轮 DeepSeek 已经明确建议 `无需再发消息`，但 app 没有结束。

2. 第 7 轮的 `user_reply` 等于第 6 轮的 `recommended_reply_80`：`好，你先休息，我忙完找你。`

3. 第 7 轮的 `target_reply` 和第 6 轮完全重复：`嗯嗯，等你忙完～我也去休息一下，拜拜～`

4. 第 7 轮继续给了全 5 分，总分又加了 10 分，最终才触发 `natural_end`。

## 代码侧原因

前端不是自动发送建议回复。它只是提供两个填入入口：

- `web/relationship-chat/app.js` 的聊天气泡 `填入` 按钮只写入 `replyInput`。
- `web/relationship-chat/app.js` 的 `useRecommendedButton` 也只写入 `replyInput`。
- 真正发送仍需要表单 submit 或 Enter。

更关键的结束逻辑在服务端游戏规则：

- `scripts/relationship-chat-game.ts` 的 `completionReasonFor()` 只看分数、重复回复、固定收尾词、最大轮数。
- 它没有读取 DeepSeek 的 `next_suggestion`。
- 第 6 轮 `user_reply = 好，那我先去忙了，忙完找你。` 没命中当前 `isNaturalClosingReply()` 的固定词规则，所以没有结束。
- 第 7 轮 `user_reply = 好，你先休息，我忙完找你。` 命中了 `先休息`，于是才结束。

## 历史模式

我扫了 `docs/deepseek-games/` 下 73 个 per-game 文件，共 474 段 DeepSeek 调用。这里只把可解释的结构信号列出来：

- 多个自动/验证玩家文件存在大量 `copywriter_as_user_reply`，这是自动玩家或填建议测试的自然结果，不等同于真实用户异常。
- 最新真实微信局 `game_mp181yzm_pfas91k0sch__seed_game_002.md` 有 8 段 DeepSeek 调用，其中 5 段是上一轮 copywriter 建议被作为本轮用户回复。
- 最新真实微信局存在 `afterEnd = true`：DeepSeek 已经给出收尾建议后，仍继续了一轮。

## 判断

当前更像产品逻辑问题，不是 DeepSeek 服务问题。

该停的时候，系统只显示 `next_suggestion`，但没有把“无需再发 / 等待对方 / 对话自然结束”转成硬结束状态。用户点建议填入后还能继续发送，于是形成“收尾句继续收尾句”的重复高分。

## 建议修复方向

1. 服务端在 `applyGameRound` 时增加一个由 DeepSeek 输出驱动的结束判断：当 `next_suggestion` 明确包含 `无需再发消息`、`等待对方主动联系`、`对话自然结束`、`停止主动联系` 时，允许结束。

2. 前端在收到强收尾 `next_suggestion` 后，禁用或隐藏继续发送入口，显示“本局完成/等待对方”。

3. `isNaturalClosingReply()` 增加常见中文收尾变体，例如 `先去忙`、`忙完找你`、`晚点聊`。

4. 对 `recommended_reply_80 === user_reply` 的连续链路做 UI 提醒：如果连续多轮直接使用建议回复，应提示这是“自动练习模式”或降低可玩性评分权重。
