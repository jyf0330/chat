#!/usr/bin/env python3
import csv
import html
import argparse
import io
import json
import os
import tarfile
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "dataset-previews"
CACHE_DIR = ROOT / ".cache" / "dataset-previews"

DAILYDIALOG_ROWS_URL = (
    "https://datasets-server.huggingface.co/rows"
    "?dataset=roskoN/dailydialog&config=full&split=train&offset=0&length={length}"
)
EMPATHETIC_TAR_URL = (
    "https://dl.fbaipublicfiles.com/parlai/empatheticdialogues/"
    "empatheticdialogues.tar.gz"
)
LMSYS_ROWS_URL = (
    "https://datasets-server.huggingface.co/rows"
    "?dataset=lmsys/chatbot_arena_conversations&config=default&split=train&offset=0&length={length}"
)
CPED_VALID_URL = "https://raw.githubusercontent.com/scutcyr/CPED/main/data/CPED/valid_split.csv"
MPDD_ZIP_URL = "https://raw.githubusercontent.com/ntunlplab/Dialogue-MPDD/main/mpdd.zip"
CHINESE_EMOTION_ROWS_URL = (
    "https://datasets-server.huggingface.co/rows"
    "?dataset=Johnson8187/Chinese_Multi-Emotion_Dialogue_Dataset&config=default&split=train&offset=0&length={length}"
)


def request_bytes(url, token=None, timeout=60):
    headers = {"User-Agent": "relationship-strategist-local-preview/0.1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def request_json(url, token=None, timeout=60):
    return json.loads(request_bytes(url, token=token, timeout=timeout).decode("utf-8"))


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def fetch_dailydialog(length=80):
    payload = request_json(DAILYDIALOG_ROWS_URL.format(length=length))
    cases = []
    for item in payload.get("rows", []):
        row = item["row"]
        turns = row.get("utterances") or []
        cases.append(
            {
                "dataset": "DailyDialog",
                "license": "CC BY-NC-SA 4.0; non-commercial/share-alike",
                "source": "https://huggingface.co/datasets/roskoN/dailydialog",
                "why_useful": "体验日常多轮对话结构、话题转接和自然短句。",
                "row_idx": item.get("row_idx"),
                "dialogue_id": row.get("id"),
                "emotion_codes": row.get("emotions"),
                "act_codes": row.get("acts"),
                "turns": [{"speaker": f"S{idx % 2 + 1}", "text": text} for idx, text in enumerate(turns)],
            }
        )
    return cases


def fetch_chinese_emotion_sentences(length=80):
    payload = request_json(CHINESE_EMOTION_ROWS_URL.format(length=length))
    cases = []
    for item in payload.get("rows", []):
        row = item["row"]
        cases.append(
            {
                "dataset": "Chinese Multi-Emotion Dialogue",
                "license": "Check Hugging Face dataset card before commercial use",
                "source": "https://huggingface.co/datasets/Johnson8187/Chinese_Multi-Emotion_Dialogue_Dataset",
                "why_useful": "中文情绪短句，适合先体验中文情绪标签和语气分类。",
                "row_idx": item.get("row_idx"),
                "emotion_context": row.get("emotion", ""),
                "turns": [{"speaker": "中文短句", "text": row.get("text", "")}],
            }
        )
    return cases


def fetch_cped(max_dialogues=60):
    raw = request_bytes(CPED_VALID_URL, timeout=60).decode("utf-8-sig", errors="replace")
    grouped = defaultdict(list)
    reader = csv.DictReader(raw.splitlines())
    for row in reader:
        grouped[row["Dialogue_ID"]].append(row)
        if len(grouped) >= max_dialogues and row["Dialogue_ID"] not in list(grouped.keys())[-1:]:
            break

    cases = []
    for row_idx, (dialogue_id, rows) in enumerate(list(grouped.items())[:max_dialogues]):
        rows.sort(key=lambda r: int(r["Utterance_ID"].split("_")[-1]))
        turns = [
            {
                "speaker": row.get("Speaker", ""),
                "text": row.get("Utterance", ""),
                "emotion": row.get("Emotion", ""),
                "dialogue_act": row.get("DA", ""),
            }
            for row in rows
        ]
        emotions = sorted({row.get("Emotion", "") for row in rows if row.get("Emotion")})
        acts = sorted({row.get("DA", "") for row in rows if row.get("DA")})
        cases.append(
            {
                "dataset": "CPED 中文个性情感对话",
                "license": "Apache-2.0",
                "source": "https://github.com/scutcyr/CPED",
                "why_useful": "中文影视多轮对话，带情绪、对话行为、角色信息，适合做中文关系/情绪判断参考。",
                "row_idx": row_idx,
                "dialogue_id": dialogue_id,
                "emotion_context": " / ".join(emotions[:6]),
                "situation_prompt": f"Scene: {rows[0].get('Scene', '')}; DA: {' / '.join(acts[:6])}",
                "turns": turns,
            }
        )
    return cases


def fetch_mpdd(max_dialogues=60):
    raw = request_bytes(MPDD_ZIP_URL, timeout=60)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        dialogue = json.loads(zf.read("mpdd/dialogue.json").decode("utf-8"))

    cases = []
    for row_idx, (dialogue_id, rows) in enumerate(list(dialogue.items())[:max_dialogues]):
        turns = []
        relations = []
        emotions = []
        for row in rows:
            listener_desc = []
            for listener in row.get("listener", []):
                relation = listener.get("relation", "")
                relations.append(relation)
                listener_desc.append(f"{listener.get('name', '')}:{relation}")
            emotions.append(row.get("emotion", ""))
            turns.append(
                {
                    "speaker": row.get("speaker", ""),
                    "text": row.get("utterance", ""),
                    "emotion": row.get("emotion", ""),
                    "listener_relation": "，".join(listener_desc),
                }
            )
        cases.append(
            {
                "dataset": "Dialogue-MPDD 中文情绪关系对话",
                "license": "Check repository README/license before commercial use",
                "source": "https://github.com/ntunlplab/Dialogue-MPDD",
                "why_useful": "中文多方对话，带 emotion 和 listener relation，特别适合体验关系标签。",
                "row_idx": row_idx,
                "dialogue_id": dialogue_id,
                "emotion_context": " / ".join(sorted({x for x in emotions if x})[:8]),
                "situation_prompt": "关系标签: " + " / ".join(sorted({x for x in relations if x})[:8]),
                "turns": turns,
            }
        )
    return cases


def ensure_empathetic_tar():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive = CACHE_DIR / "empatheticdialogues.tar.gz"
    if not archive.exists() or archive.stat().st_size < 1024:
        archive.write_bytes(request_bytes(EMPATHETIC_TAR_URL, timeout=120))
    return archive


def fetch_empathetic_dialogues(max_dialogues=80):
    archive = ensure_empathetic_tar()
    grouped = defaultdict(list)
    meta = {}
    with tarfile.open(archive, "r:gz") as tar:
        member = tar.getmember("empatheticdialogues/train.csv")
        extracted = tar.extractfile(member)
        if extracted is None:
            raise RuntimeError("Could not read empatheticdialogues/train.csv")
        text_rows = (line.decode("utf-8") for line in extracted)
        reader = csv.DictReader(text_rows)
        for row in reader:
            conv_id = row["conv_id"]
            grouped[conv_id].append(row)
            meta.setdefault(
                conv_id,
                {
                    "context": row.get("context", ""),
                    "prompt": row.get("prompt", ""),
                    "selfeval": row.get("selfeval", ""),
                    "tags": row.get("tags", ""),
                },
            )
            if len(grouped) >= max_dialogues and conv_id not in list(grouped.keys())[-1:]:
                break

    cases = []
    for row_idx, (conv_id, rows) in enumerate(list(grouped.items())[:max_dialogues]):
        rows.sort(key=lambda r: int(r["utterance_idx"]))
        turns = [
            {
                "speaker": f"S{int(row['speaker_idx']) + 1}",
                "text": row["utterance"].replace("_comma_", ","),
            }
            for row in rows
        ]
        cases.append(
            {
                "dataset": "EmpatheticDialogues",
                "license": "CC-BY-NC-4.0; non-commercial",
                "source": "https://huggingface.co/datasets/facebook/empathetic_dialogues",
                "why_useful": "体验情绪场景、共情回应和先接情绪再表达。",
                "row_idx": row_idx,
                "dialogue_id": conv_id,
                "emotion_context": meta[conv_id]["context"],
                "situation_prompt": meta[conv_id]["prompt"].replace("_comma_", ","),
                "selfeval": meta[conv_id]["selfeval"],
                "tags": meta[conv_id]["tags"],
                "turns": turns,
            }
        )
    return cases


def fetch_lmsys(length=30):
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    try:
        payload = request_json(LMSYS_ROWS_URL.format(length=length), token=token)
    except urllib.error.HTTPError as exc:
        return [], {
            "dataset": "LMSYS Chatbot Arena Conversations",
            "status": "blocked",
            "reason": f"HTTP {exc.code}: gated dataset or token/terms not accepted",
            "how_to_fix": [
                "打开 https://huggingface.co/datasets/lmsys/chatbot_arena_conversations",
                "登录 Hugging Face 并同意数据条款",
                "创建 access token 后执行：HF_TOKEN=你的token python3 scripts/fetch_dataset_previews.py",
            ],
        }
    except Exception as exc:
        return [], {
            "dataset": "LMSYS Chatbot Arena Conversations",
            "status": "blocked",
            "reason": str(exc),
            "how_to_fix": ["稍后重试，或先只体验 DailyDialog 和 EmpatheticDialogues。"],
        }

    cases = []
    for item in payload.get("rows", []):
        row = item["row"]
        cases.append(
            {
                "dataset": "LMSYS Chatbot Arena Conversations",
                "license": "Gated Hugging Face dataset; follow accepted terms",
                "source": "https://huggingface.co/datasets/lmsys/chatbot_arena_conversations",
                "why_useful": "体验真实用户如何比较两个 AI 回复，适合做偏好评估参考。",
                "row_idx": item.get("row_idx"),
                "question_id": row.get("question_id"),
                "winner": row.get("winner"),
                "model_a": row.get("model_a"),
                "model_b": row.get("model_b"),
                "conversation_a": row.get("conversation_a"),
                "conversation_b": row.get("conversation_b"),
                "turns": [],
            }
        )
    return cases, {"dataset": "LMSYS Chatbot Arena Conversations", "status": "ok"}


def render_turns(turns):
    parts = []
    for turn in turns:
        speaker = html.escape(str(turn.get("speaker", "")))
        text = html.escape(str(turn.get("text", "")))
        parts.append(f"<div class='turn'><b>{speaker}</b><span>{text}</span></div>")
    return "\n".join(parts)


def build_html(all_cases, status):
    data_json = json.dumps(all_cases, ensure_ascii=False)
    status_json = json.dumps(status, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>关系策略师数据体验包</title>
  <style>
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #172033; }}
    header {{ padding: 28px 32px 18px; background: #ffffff; border-bottom: 1px solid #e5e7eb; }}
    h1 {{ margin: 0 0 8px; font-size: 26px; }}
    p {{ margin: 0; color: #5d6678; line-height: 1.6; }}
    .toolbar {{ display: flex; gap: 10px; flex-wrap: wrap; padding: 18px 32px; background: #ffffff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; z-index: 2; }}
    input, select {{ height: 38px; border: 1px solid #cfd6e4; border-radius: 8px; padding: 0 10px; font-size: 14px; background: white; }}
    input {{ min-width: 280px; flex: 1; }}
    main {{ padding: 20px 32px 40px; display: grid; gap: 14px; }}
    .card {{ background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }}
    .meta {{ display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }}
    .pill {{ font-size: 12px; background: #eef2ff; color: #3730a3; padding: 5px 8px; border-radius: 999px; }}
    .pill.gray {{ background: #f1f5f9; color: #475569; }}
    .pill.warn {{ background: #fff7ed; color: #9a3412; }}
    .turn {{ display: grid; grid-template-columns: 42px 1fr; gap: 10px; padding: 8px 0; border-top: 1px solid #f1f3f6; }}
    .turn:first-child {{ border-top: 0; }}
    .turn b {{ color: #334155; }}
    .turn span {{ line-height: 1.55; }}
    .note {{ color: #5d6678; margin: 8px 0 12px; line-height: 1.55; }}
    .empty {{ padding: 24px; color: #64748b; }}
    .status {{ margin-top: 10px; padding: 12px; background: #fff7ed; color: #9a3412; border: 1px solid #fed7aa; border-radius: 8px; }}
  </style>
</head>
<body>
  <header>
    <h1>关系策略师数据体验包</h1>
    <p>本页是本地预览：中文优先看 CPED、MPDD、中文多情绪短句；英文数据仅作结构参考。非商业训练前请重新确认许可。</p>
    <div id="status"></div>
  </header>
  <section class="toolbar">
    <select id="dataset"></select>
    <input id="q" placeholder="搜 tired / sorry / date / angry / 关键词">
  </section>
  <main id="cards"></main>
  <script>
    const DATA = {data_json};
    const STATUS = {status_json};
    const datasetSelect = document.getElementById('dataset');
    const q = document.getElementById('q');
    const cards = document.getElementById('cards');
    const statusBox = document.getElementById('status');

    const names = ['全部', ...Array.from(new Set(DATA.map(x => x.dataset)))];
    datasetSelect.innerHTML = names.map(x => `<option>${{x}}</option>`).join('');

    const notices = STATUS.filter(x => x.status !== 'ok');
    if (notices.length) {{
      statusBox.innerHTML = notices.map(item => `<div class="status">${{escapeHtml(item.dataset)}} 暂未拉取：${{escapeHtml(item.reason || item.status)}}。</div>`).join('');
    }}

    function textOf(item) {{
      return JSON.stringify(item).toLowerCase();
    }}

    function render() {{
      const selected = datasetSelect.value;
      const needle = q.value.trim().toLowerCase();
      const rows = DATA.filter(item => {{
        return (selected === '全部' || item.dataset === selected) && (!needle || textOf(item).includes(needle));
      }});
      cards.innerHTML = rows.length ? rows.map(item => {{
        const turns = (item.turns || []).map(t => {{
          const sub = [t.emotion && `情绪:${{t.emotion}}`, t.dialogue_act && `行为:${{t.dialogue_act}}`, t.listener_relation && `关系:${{t.listener_relation}}`].filter(Boolean).join(' · ');
          return `<div class="turn"><b>${{escapeHtml(t.speaker || '')}}</b><span>${{escapeHtml(t.text || '')}}${{sub ? `<br><small>${{escapeHtml(sub)}}</small>` : ''}}</span></div>`;
        }}).join('');
        const extra = item.emotion_context ? `<div class="note">情绪场景：${{escapeHtml(item.emotion_context)}}<br>背景：${{escapeHtml(item.situation_prompt || '')}}</div>` : '';
        const winner = item.winner ? `<span class="pill warn">winner: ${{escapeHtml(item.winner)}}</span>` : '';
        return `<article class="card">
          <div class="meta">
            <span class="pill">${{escapeHtml(item.dataset)}}</span>
            <span class="pill gray">${{escapeHtml(item.license || '')}}</span>
            ${{winner}}
          </div>
          <div class="note">${{escapeHtml(item.why_useful || '')}}</div>
          ${{extra}}
          ${{turns || '<div class="empty">这个样例没有普通 turns 字段，可打开 JSONL 看原始结构。</div>'}}
        </article>`;
      }}).join('') : '<div class="empty">没有匹配结果。</div>';
    }}

    function escapeHtml(value) {{
      return String(value).replace(/[&<>"']/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
    }}

    datasetSelect.addEventListener('change', render);
    q.addEventListener('input', render);
    render();
  </script>
</body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description="Fetch small local previews for public dialogue datasets.")
    parser.add_argument(
        "--with-empathetic-download",
        action="store_true",
        help="Also download the full EmpatheticDialogues source tarball. It can be slow on first run.",
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    status = []

    cped = fetch_cped()
    mpdd = fetch_mpdd()
    chinese_emotion = fetch_chinese_emotion_sentences()
    daily = fetch_dailydialog()
    if args.with_empathetic_download:
        try:
            empathetic = fetch_empathetic_dialogues()
            status.append({"dataset": "EmpatheticDialogues", "status": "ok"})
        except Exception as exc:
            empathetic = []
            status.append(
                {
                    "dataset": "EmpatheticDialogues",
                    "status": "blocked",
                    "reason": f"download failed: {exc}",
                    "how_to_fix": [
                        "稍后重试：python3 scripts/fetch_dataset_previews.py --with-empathetic-download",
                        "或直接打开 https://huggingface.co/datasets/facebook/empathetic_dialogues 体验页面样例",
                    ],
                }
            )
    else:
        empathetic = []
        status.append(
            {
                "dataset": "EmpatheticDialogues",
                "status": "skipped",
                "reason": "quick mode skipped the slow source tarball download",
                "how_to_fix": [
                    "需要本地样例时运行：python3 scripts/fetch_dataset_previews.py --with-empathetic-download"
                ],
            }
        )
    lmsys, lmsys_status = fetch_lmsys()
    status.append(lmsys_status)

    write_jsonl(OUT_DIR / "cped.preview.jsonl", cped)
    write_jsonl(OUT_DIR / "dialogue_mpdd.preview.jsonl", mpdd)
    write_jsonl(OUT_DIR / "chinese_multi_emotion.preview.jsonl", chinese_emotion)
    write_jsonl(OUT_DIR / "dailydialog.preview.jsonl", daily)
    write_jsonl(OUT_DIR / "empathetic_dialogues.preview.jsonl", empathetic)
    if lmsys:
        write_jsonl(OUT_DIR / "lmsys_chatbot_arena.preview.jsonl", lmsys)

    all_cases = cped + mpdd + chinese_emotion + daily + empathetic + lmsys
    (OUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "counts": {
                    "CPED 中文个性情感对话": len(cped),
                    "Dialogue-MPDD 中文情绪关系对话": len(mpdd),
                    "Chinese Multi-Emotion Dialogue": len(chinese_emotion),
                    "DailyDialog": len(daily),
                    "EmpatheticDialogues": len(empathetic),
                    "LMSYS Chatbot Arena Conversations": len(lmsys),
                },
                "status": status,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (OUT_DIR / "index.html").write_text(build_html(all_cases, status), encoding="utf-8")
    print(f"Wrote {OUT_DIR / 'index.html'}")
    print(
        "Counts: "
        f"CPED={len(cped)}, MPDD={len(mpdd)}, ChineseEmotion={len(chinese_emotion)}, "
        f"DailyDialog={len(daily)}, EmpatheticDialogues={len(empathetic)}, LMSYS={len(lmsys)}"
    )
    if lmsys_status.get("status") != "ok":
        print("LMSYS gated:", lmsys_status.get("reason"))


if __name__ == "__main__":
    main()
