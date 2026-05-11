# 本地体验公开对话数据集

这个体验包只用于本机查看样例，帮助判断哪些公开数据能给“关系策略师”提供参考。现在默认中文优先：CPED、Dialogue-MPDD、中文多情绪短句会先生成；英文数据只作为结构参考。不要把这些数据直接当商业训练集使用；商业训练前需要重新确认许可和授权范围。

## 一键生成

```bash
python3 scripts/fetch_dataset_previews.py
```

默认快速模式会先拉 DailyDialog，并显示 LMSYS/EmpatheticDialogues 的状态。EmpatheticDialogues 的公开源文件较大，第一次下载可能比较慢；需要完整本地体验时运行：

```bash
python3 scripts/fetch_dataset_previews.py --with-empathetic-download
```

生成结果：

- `data/dataset-previews/index.html`：本地浏览器预览页
- `data/dataset-previews/cped.preview.jsonl`：CPED 中文个性情感多轮对话样例
- `data/dataset-previews/dialogue_mpdd.preview.jsonl`：Dialogue-MPDD 中文情绪+关系对话样例
- `data/dataset-previews/chinese_multi_emotion.preview.jsonl`：中文多情绪短句样例
- `data/dataset-previews/dailydialog.preview.jsonl`：DailyDialog 样例
- `data/dataset-previews/empathetic_dialogues.preview.jsonl`：EmpatheticDialogues 样例
- `data/dataset-previews/lmsys_chatbot_arena.preview.jsonl`：LMSYS 样例，只有在账号通过 gated dataset 条款后才会生成
- `data/dataset-previews/summary.json`：拉取数量和状态

## LMSYS 需要登录

LMSYS Chatbot Arena Conversations 是 gated dataset。先打开：

https://huggingface.co/datasets/lmsys/chatbot_arena_conversations

登录 Hugging Face，同意数据条款，创建 access token，然后运行：

```bash
HF_TOKEN=你的token python3 scripts/fetch_dataset_previews.py
```

## 中文数据集的用途

- CPED：中文影视多轮对话，带情绪、对话行为、角色信息。
- Dialogue-MPDD：中文多方对话，带 emotion 和 listener relation，尤其适合看关系标签。
- Chinese Multi-Emotion Dialogue：中文情绪短句，适合快速看中文语气分类。

## 英文数据集的用途

- DailyDialog：看日常多轮对话怎么展开。
- EmpatheticDialogues：看情绪场景下怎么先接住感受。
- LMSYS Chatbot Arena Conversations：看真实用户偏好如何比较两个 AI 回复。

## 对关系策略师的建议用法

把这些数据当“教材”和“体验样本”，不要当核心资产。真正有价值的数据应该是你自己的结构化案例：

```json
{
  "stage": "暧昧初期",
  "emotion": "疲惫",
  "risk_level": "medium",
  "latest_message": "最近真的有点累，改天再说吧。",
  "best_strategy": "降压 + 体贴 + 保留连接",
  "wrong_moves": ["追问原因", "表达委屈", "连续补消息"],
  "best_reply": "那你先好好休息，别硬撑。等你缓过来我们再聊，我不催你。",
  "next_step": "今晚不补消息，明天中午轻问候"
}
```
