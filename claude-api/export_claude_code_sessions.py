#!/usr/bin/env python3
"""
claude-api/export_claude_code_sessions.py

Xuất toàn bộ lịch sử các phiên làm việc Claude Code CLI (~/.claude/projects/*.jsonl)
vào cấu trúc chuẩn tương đương chatgpt-api/data:
  - conversations.json             (Tổng hợp metadata tất cả phiên)
  - conversations/<id>.json        (Chi tiết đầy đủ từng phiên)
  - conversations_md/<file>.md     (Bản Markdown định dạng đẹp từng phiên)
  - conversations_md/index.md      (Mục lục Markdown tra cứu nhanh)
  - summary.txt                    (Báo cáo tóm tắt thống kê chuẩn ASCII)
  - history.jsonl                  (Lưu trữ toàn bộ lệnh CLI trong ~/.claude/history.jsonl)

Usage:
    python3 export_claude_code_sessions.py [output_dir]
"""

import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
CLAUDE_PROJECTS_DIR = CLAUDE_DIR / "projects"
CLAUDE_HISTORY_FILE = CLAUDE_DIR / "history.jsonl"


def clean_filename(title: str, max_len: int = 55) -> str:
    """Tạo tên file an toàn cho hệ thống tệp."""
    clean = re.sub(r'https?://[^\s]+', 'url', title)
    clean = re.sub(r'[\/:*?"<>|#%&{}\\~]', '', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:max_len].strip() or "Untitled"


def format_timestamp(iso_str: str) -> str:
    """Định dạng chuỗi ISO sang YYYY-MM-DD HH:mm:ss."""
    if not iso_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return iso_str[:19].replace("T", " ")


def resolve_project_path(folder_name: str) -> tuple[str, str]:
    """
    Chuyển tên thư mục dạng -Users-tructt-... thành đường dẫn thực tế và tên ngắn.
    """
    candidates = [
        Path("/Users/tructt/Public/Projects/centrix-wine-tools"),
        Path("/Users/tructt/Public/Projects/digital-banking-masterclass"),
        Path("/Users/tructt/Public/digital-transformation-study"),
        Path("/Users/tructt/Public"),
        Path("/Users/tructt/.openclaw"),
        Path("/Users/tructt/Public/cacq-mobile-app"),
    ]
    for c in candidates:
        encoded = str(c).replace("/", "-")
        if encoded == folder_name:
            return str(c), c.name

    # Fallback nếu không khớp danh sách định sẵn
    if folder_name.startswith("-"):
        parts = folder_name.lstrip("-").split("-")
        return "/" + "/".join(parts), parts[-1]
    return folder_name, folder_name


def parse_session_jsonl(file_path: Path) -> dict | None:
    session_id = file_path.stem
    folder_name = file_path.parent.name
    project_path, short_project = resolve_project_path(folder_name)

    created_at = ""
    updated_at = ""
    custom_title = ""
    ai_title = ""
    meaningful_prompts = []
    models = set()
    tools_used = set()
    git_branch = ""
    cwd = ""

    parsed_turns = []
    raw_messages_count = 0
    human_prompt_count = 0
    assistant_msg_count = 0
    tool_call_count = 0

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue

                ts = obj.get("timestamp", "")
                if not created_at and ts:
                    created_at = ts
                if ts:
                    updated_at = ts

                if not git_branch and obj.get("gitBranch"):
                    git_branch = obj.get("gitBranch")
                if not cwd and obj.get("cwd"):
                    cwd = obj.get("cwd")

                mtype = obj.get("type")

                if mtype == "custom-title":
                    ct = obj.get("customTitle", "").strip()
                    if ct and ct != "New session":
                        custom_title = ct

                elif mtype == "ai-title":
                    at = obj.get("aiTitle", "").strip()
                    if at:
                        ai_title = at

                elif mtype == "user":
                    raw_messages_count += 1
                    msg = obj.get("message", {})
                    content = msg.get("content", "")

                    if isinstance(content, str):
                        human_prompt_count += 1
                        clean_c = content.strip()
                        if clean_c and not clean_c.startswith("<local-command") and not clean_c.startswith("<command-"):
                            meaningful_prompts.append(clean_c)

                        parsed_turns.append({
                            "type": "human",
                            "timestamp": ts,
                            "text": content,
                            "cwd": obj.get("cwd", cwd),
                            "git_branch": obj.get("gitBranch", git_branch),
                            "uuid": obj.get("uuid", ""),
                        })
                    elif isinstance(content, list):
                        # Tool results
                        tool_results = []
                        for b in content:
                            if isinstance(b, dict) and b.get("type") == "tool_result":
                                output_text = b.get("content", "")
                                if isinstance(output_text, list):
                                    output_text = "\n".join(
                                        p.get("text", "") for p in output_text if isinstance(p, dict) and p.get("type") == "text"
                                    )
                                tool_results.append({
                                    "tool_use_id": b.get("tool_use_id", ""),
                                    "is_error": b.get("is_error", False),
                                    "output": str(output_text)[:2000],
                                })
                        parsed_turns.append({
                            "type": "tool_results",
                            "timestamp": ts,
                            "results": tool_results,
                            "uuid": obj.get("uuid", ""),
                        })

                elif mtype == "assistant":
                    raw_messages_count += 1
                    assistant_msg_count += 1
                    msg = obj.get("message", {})
                    model_name = msg.get("model", "")
                    if model_name:
                        models.add(model_name)

                    content = msg.get("content", [])
                    texts = []
                    tool_calls = []
                    thinking_texts = []

                    if isinstance(content, list):
                        for b in content:
                            if not isinstance(b, dict):
                                continue
                            b_type = b.get("type")
                            if b_type == "text":
                                texts.append(b.get("text", ""))
                            elif b_type == "tool_use":
                                tool_call_count += 1
                                tname = b.get("name", "unknown")
                                tools_used.add(tname)
                                tool_calls.append({
                                    "name": tname,
                                    "id": b.get("id", ""),
                                    "input": b.get("input", {}),
                                })
                            elif b_type == "thinking":
                                th = b.get("thinking", "")
                                if th:
                                    thinking_texts.append(th)
                    elif isinstance(content, str):
                        texts.append(content)

                    parsed_turns.append({
                        "type": "assistant",
                        "timestamp": ts,
                        "model": model_name,
                        "text": "\n".join(texts),
                        "tool_calls": tool_calls,
                        "thinking": "\n".join(thinking_texts),
                        "uuid": obj.get("uuid", ""),
                    })

    except Exception as e:
        print(f"⚠️  Lỗi khi đọc {file_path.name}: {e}")
        return None

    if not parsed_turns:
        return None

    # Xác định tiêu đề tốt nhất
    title = custom_title or ai_title
    if not title:
        for p in meaningful_prompts:
            first_line = p.split("\n")[0].strip()
            if "digital-transformation-practitioner" in first_line:
                title = "Udemy - Digital Transformation Practitioner"
                break
            if first_line.lower() not in ("hi", "ping", "say hi", "say pong", "say ok", "test", "hello"):
                title = first_line[:65]
                break
        if not title and meaningful_prompts:
            title = meaningful_prompts[0].split("\n")[0][:60]
        if not title:
            title = f"Session {session_id[:8]}"

    # Phân loại và sắp xếp models (đưa model thật lên đầu thay vì <synthetic>)
    sorted_models = sorted(list(models), key=lambda x: (x.startswith("<"), x))

    return {
        "id": session_id,
        "title": title,
        "project": project_path,
        "short_project": short_project,
        "cwd": cwd or project_path,
        "git_branch": git_branch,
        "created_at": created_at,
        "updated_at": updated_at,
        "models": sorted_models,
        "tools_used": sorted(list(tools_used)),
        "stats": {
            "human_prompts": human_prompt_count,
            "assistant_messages": assistant_msg_count,
            "tool_calls": tool_call_count,
            "total_records": raw_messages_count,
        },
        "turns": parsed_turns,
    }


def generate_markdown(session: dict) -> str:
    created_fmt = format_timestamp(session["created_at"])
    updated_fmt = format_timestamp(session["updated_at"])
    
    # Lọc danh sách model hiển thị
    real_models = [m for m in session["models"] if not m.startswith("<")]
    models_disp = ", ".join(real_models) if real_models else (", ".join(session["models"]) if session["models"] else "Claude")
    tools_str = ", ".join(session["tools_used"]) if session["tools_used"] else "None"
    stats = session["stats"]

    md_lines = [
        f"# {session['title']}",
        "",
        f"> **Session ID:** `{session['id']}`  ",
        f"> **Dự án:** `{session['project']}`  ",
        f"> **Mô hình:** `{models_disp}`  ",
        f"> **Thời gian tạo:** {created_fmt}  ",
        f"> **Cập nhật lần cuối:** {updated_fmt}  ",
        f"> **Thống kê:** {stats['human_prompts']} lượt người dùng · {stats['assistant_messages']} phản hồi assistant · {stats['tool_calls']} lệnh công cụ  ",
    ]

    if session.get("git_branch"):
        md_lines.append(f"> **Git Branch:** `{session['git_branch']}`  ")

    if session["tools_used"]:
        md_lines.append(f"> **Công cụ đã dùng:** `{tools_str}`  ")

    md_lines.extend(["", "---", ""])

    for turn in session["turns"]:
        ttype = turn.get("type")
        ts = format_timestamp(turn.get("timestamp", ""))

        if ttype == "human":
            md_lines.append(f"### 👤 Người dùng · {ts}")
            md_lines.append("")
            md_lines.append(turn.get("text", "").strip())
            md_lines.append("")
            md_lines.append("---")
            md_lines.append("")

        elif ttype == "assistant":
            mname = turn.get("model") or "Claude Code"
            md_lines.append(f"### 🤖 Claude Code ({mname}) · {ts}")
            md_lines.append("")

            # Hiển thị text phản hồi chính
            text = turn.get("text", "").strip()
            if text:
                md_lines.append(text)
                md_lines.append("")

            # Hiển thị tóm tắt các tool calls nếu có
            tool_calls = turn.get("tool_calls", [])
            if tool_calls:
                tool_summary = ", ".join(f"`{tc['name']}`" for tc in tool_calls)
                md_lines.append("<details>")
                md_lines.append(f"<summary>🛠️ <i>Đã thực thi công cụ ({len(tool_calls)}): {tool_summary}</i></summary>")
                md_lines.append("")
                for tc in tool_calls:
                    md_lines.append(f"**Công cụ:** `{tc['name']}`")
                    inp = tc.get("input", {})
                    if inp:
                        inp_json = json.dumps(inp, ensure_ascii=False, indent=2)
                        if len(inp_json) > 1000:
                            inp_json = inp_json[:1000] + "\n..."
                        md_lines.append("```json")
                        md_lines.append(inp_json)
                        md_lines.append("```")
                md_lines.append("</details>")
                md_lines.append("")

            md_lines.append("---")
            md_lines.append("")

        elif ttype == "tool_results":
            results = turn.get("results", [])
            err_count = sum(1 for r in results if r.get("is_error"))
            status = f" ({err_count} lỗi)" if err_count else ""
            md_lines.append("<details>")
            md_lines.append(f"<summary>⚙️ <i>Kết quả thực thi từ hệ thống ({len(results)} kết quả{status})</i></summary>")
            md_lines.append("")
            for r in results:
                out = r.get("output", "").strip()
                if out:
                    if len(out) > 1200:
                        out = out[:1200] + "\n...(cắt ngắn)"
                    md_lines.append("```text")
                    md_lines.append(out)
                    md_lines.append("```")
            md_lines.append("</details>")
            md_lines.append("")
            md_lines.append("---")
            md_lines.append("")

    return "\n".join(md_lines)


def generate_summary_text(all_sessions: list, out_dir: Path) -> str:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    total_sessions = len(all_sessions)
    total_human = sum(s["stats"]["human_prompts"] for s in all_sessions)
    total_asst = sum(s["stats"]["assistant_messages"] for s in all_sessions)
    total_tools = sum(s["stats"]["tool_calls"] for s in all_sessions)
    total_records = sum(s["stats"]["total_records"] for s in all_sessions)

    projects = {}
    models_count = {}
    for s in all_sessions:
        p = s["project"]
        projects[p] = projects.get(p, 0) + 1
        for m in s["models"]:
            models_count[m] = models_count.get(m, 0) + 1

    lines = [
        "╔══════════════════════════════════════════════════════════════╗",
        "║  Claude Code CLI Sessions Export Summary                     ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        f"  💻 Host OS:        macOS ({HOME.name})",
        f"  📁 Source Dir:     {CLAUDE_PROJECTS_DIR}",
        f"  📅 Exported at:    {now_str}",
        f"  📊 Total Sessions: {total_sessions}",
        f"  💬 Human Prompts:  {total_human}",
        f"  🤖 Asst Responses: {total_asst}",
        f"  🛠️  Tool Actions:   {total_tools}",
        f"  📑 Total Records:  {total_records}",
        "",
        "── Projects Covered ───────────────────────────────────────────",
    ]

    for proj, count in sorted(projects.items(), key=lambda x: x[1], reverse=True):
        lines.append(f"  • {proj:<55} : {count:2d} session(s)")

    lines.extend([
        "",
        "── Models Used ────────────────────────────────────────────────",
    ])
    for model, count in sorted(models_count.items(), key=lambda x: x[1], reverse=True):
        lines.append(f"  • {model:<40} : {count:2d} session(s)")

    lines.extend([
        "",
        "── Output Structure ───────────────────────────────────────────",
        f"  {out_dir}/conversations.json            (Toàn bộ danh sách metadata)",
        f"  {out_dir}/conversations/<id>.json       (Chi tiết đầy đủ dữ liệu phiên)",
        f"  {out_dir}/conversations_md/<file>.md    (Bản xem Markdown định dạng đẹp)",
        f"  {out_dir}/conversations_md/index.md     (Mục lục Markdown tra cứu)",
        f"  {out_dir}/history.jsonl                 (Lưu trữ 1,580 lệnh CLI lịch sử)",
        f"  {out_dir}/summary.txt                   (File tóm tắt này)",
        "",
        "════════════════════════════════════════════════════════════════",
    ])

    return "\n".join(lines)


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "data" / "claude_code_cli"
    conv_json_dir = out_dir / "conversations"
    conv_md_dir = out_dir / "conversations_md"

    conv_json_dir.mkdir(parents=True, exist_ok=True)
    conv_md_dir.mkdir(parents=True, exist_ok=True)

    if not CLAUDE_PROJECTS_DIR.exists():
        print(f"❌ Không tìm thấy thư mục Claude projects: {CLAUDE_PROJECTS_DIR}")
        sys.exit(1)

    jsonl_files = sorted(CLAUDE_PROJECTS_DIR.rglob("*.jsonl"))
    print(f"🔍 Quét thấy {len(jsonl_files)} file phiên làm việc trong {CLAUDE_PROJECTS_DIR}...")

    all_sessions = []
    conversations_index_items = []

    for idx, f in enumerate(jsonl_files, 1):
        session = parse_session_jsonl(f)
        if not session:
            continue

        session_id = session["id"]
        title = session["title"]
        date_str = format_timestamp(session["created_at"])
        prefix_date = date_str[:10] if len(date_str) >= 10 else "1970-01-01"
        prefix_time = date_str[11:16].replace(":", "") if len(date_str) >= 16 else "0000"
        md_filename = f"{prefix_date}_{prefix_time}_{clean_filename(title)}.md"

        # 1. Ghi conversations/<session_id>.json
        json_file_path = conv_json_dir / f"{session_id}.json"
        with open(json_file_path, "w", encoding="utf-8") as jf:
            json.dump(session, jf, ensure_ascii=False, indent=2)

        # 2. Ghi conversations_md/<md_filename>
        md_content = generate_markdown(session)
        md_file_path = conv_md_dir / md_filename
        md_file_path.write_text(md_content, encoding="utf-8")

        all_sessions.append(session)
        conversations_index_items.append({
            "id": session_id,
            "title": title,
            "project": session["project"],
            "short_project": session["short_project"],
            "created_at": session["created_at"],
            "updated_at": session["updated_at"],
            "created_fmt": date_str,
            "models": session["models"],
            "tools_used": session["tools_used"],
            "stats": session["stats"],
            "json_file": f"conversations/{session_id}.json",
            "md_file": f"conversations_md/{md_filename}",
            "filename": md_filename,
        })

    # Sắp xếp theo ngày giảm dần (mới nhất lên đầu)
    conversations_index_items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    all_sessions.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    # 3. Ghi conversations.json
    conversations_json_data = {
        "source": "Claude Code CLI",
        "exported_at": datetime.now().isoformat(),
        "total_sessions": len(conversations_index_items),
        "items": conversations_index_items,
    }
    with open(out_dir / "conversations.json", "w", encoding="utf-8") as cjf:
        json.dump(conversations_json_data, cjf, ensure_ascii=False, indent=2)

    # 4. Ghi conversations_md/index.md
    index_lines = [
        "# 📚 Claude Code CLI Sessions Index",
        "",
        f"> Được xuất tự động vào: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · Tổng cộng: **{len(conversations_index_items)} phiên làm việc**",
        "",
        "| # | Ngày | Dự án | Tiêu đề | Model | Lượt hỏi | Tổng bản ghi | Session ID |",
        "|---|------|-------|---------|-------|----------|--------------|------------|",
    ]

    for idx, item in enumerate(conversations_index_items, 1):
        safe_title = item["title"].replace("|", "\\|")
        real_models = [m for m in item["models"] if not m.startswith("<")]
        models_disp = ", ".join(real_models) if real_models else (", ".join(item["models"]) if item["models"] else "Claude")
        index_lines.append(
            f"| {idx} | {item['created_fmt']} | `{item['short_project']}` | [{safe_title}]({item['filename']}) | `{models_disp}` | {item['stats']['human_prompts']} | {item['stats']['total_records']} | `{item['id'][:8]}…` |"
        )

    (conv_md_dir / "index.md").write_text("\n".join(index_lines), encoding="utf-8")

    # 5. Backup history.jsonl nếu tồn tại
    if CLAUDE_HISTORY_FILE.exists():
        shutil.copy2(CLAUDE_HISTORY_FILE, out_dir / "history.jsonl")
        print(f"📋 Đã sao chép lịch sử CLI ({CLAUDE_HISTORY_FILE.stat().st_size:,} bytes) vào {out_dir / 'history.jsonl'}")

    # 6. Ghi summary.txt
    summary_text = generate_summary_text(all_sessions, out_dir)
    (out_dir / "summary.txt").write_text(summary_text, encoding="utf-8")

    print(f"\n🎉 HOÀN TẤT XUẤT {len(all_sessions)} PHIÊN CLAUDE CODE CLI!")
    print(f"📁 Thư mục xuất: {out_dir}")
    print(f"   ├── conversations.json")
    print(f"   ├── conversations/ ({len(all_sessions)} file JSON)")
    print(f"   ├── conversations_md/ ({len(all_sessions)} file Markdown + index.md)")
    print(f"   ├── history.jsonl")
    print(f"   └── summary.txt")


if __name__ == "__main__":
    main()
