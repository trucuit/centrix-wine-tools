#!/usr/bin/env python3
"""
claude-api/convert_claude_to_md.py

Chuyển đổi các file JSON chi tiết hội thoại Claude sang Markdown định dạng đẹp.
Tạo file index.md tổng hợp danh sách cuộc hội thoại theo thời gian.

Usage:
    python3 convert_claude_to_md.py <conversations_dir> [assets_dir]
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def clean_filename(title: str, max_len: int = 50) -> str:
    """Tạo tên file an toàn cho hệ thống tệp."""
    clean = re.sub(r'[\/:*?"<>|#%&{}\\~]', '', title)
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


def convert_conversation(json_path: Path, assets_dir: Path = None, md_dir: Path = None) -> tuple[dict, str]:
    """Chuyển 1 cuộc hội thoại sang chuỗi Markdown."""
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        return {}, f"Lỗi đọc JSON: {e}"

    cid = data.get("uuid") or data.get("id") or json_path.stem
    title = data.get("name") or data.get("title") or "Untitled"
    created_at = data.get("created_at", "")
    updated_at = data.get("updated_at", "")
    model = data.get("model", "Claude")

    date_str = format_timestamp(created_at)
    prefix_date = date_str[:10] if len(date_str) >= 10 else "1970-01-01"
    prefix_time = date_str[11:16].replace(":", "") if len(date_str) >= 16 else "0000"

    messages = data.get("chat_messages", [])

    md_lines = [
        f"# {title}",
        "",
        f"> **Thời gian tạo:** {date_str}  ",
        f"> **Cập nhật lần cuối:** {format_timestamp(updated_at)}  ",
        f"> **Mô hình:** `{model}`  ",
        f"> **Số tin nhắn:** {len(messages)}  ",
        "",
        "---",
        ""
    ]

    for msg in messages:
        sender = msg.get("sender") or "unknown"
        text = msg.get("text") or ""
        msg_time = format_timestamp(msg.get("created_at", ""))

        if sender == "human":
            md_lines.append(f"### 👤 Người dùng · {msg_time}")
            md_lines.append("")
            # Attachments nếu có
            attachments = msg.get("attachments", [])
            for att in attachments:
                fname = att.get("file_name", "attachment")
                md_lines.append(f"> 📎 **Đính kèm:** `{fname}`")
                md_lines.append("")
            md_lines.append(text)
            md_lines.append("")
            md_lines.append("---")
            md_lines.append("")
        else:
            md_lines.append(f"### 🤖 Claude · {msg_time}")
            md_lines.append("")
            md_lines.append(text)
            md_lines.append("")
            md_lines.append("---")
            md_lines.append("")

    meta = {
        "id": cid,
        "title": title,
        "date": date_str,
        "model": model,
        "messages_count": len(messages),
        "filename": f"{prefix_date}_{prefix_time}_{clean_filename(title)}.md"
    }

    return meta, "\n".join(md_lines)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <conversations_dir> [assets_dir]")
        sys.exit(1)

    conv_dir = Path(sys.argv[1])
    assets_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else conv_dir.parent / "assets"
    md_dir = conv_dir.parent / "conversations_md"
    md_dir.mkdir(parents=True, exist_ok=True)

    json_files = sorted(conv_dir.glob("*.json"))
    if not json_files:
        print(f"⚠️  Không tìm thấy file JSON nào trong {conv_dir}")
        sys.exit(0)

    print(f"🔄 Đang chuyển đổi {len(json_files)} cuộc hội thoại sang Markdown...")
    all_meta = []

    for idx, f in enumerate(json_files, 1):
        meta, md_content = convert_conversation(f, assets_dir, md_dir)
        if meta and "filename" in meta:
            target_md = md_dir / meta["filename"]
            target_md.write_text(md_content, encoding="utf-8")
            all_meta.append(meta)

    # Sắp xếp theo ngày giảm dần
    all_meta.sort(key=lambda x: x.get("date", ""), reverse=True)

    # Tạo file index.md
    index_lines = [
        "# 📚 Claude Conversations Index",
        "",
        f"> Được tạo tự động vào: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · Tổng cộng: **{len(all_meta)} cuộc hội thoại**",
        "",
        "| # | Ngày | Tiêu đề | Model | Tin nhắn |",
        "|---|------|---------|-------|----------|"
    ]

    for idx, m in enumerate(all_meta, 1):
        safe_title = m["title"].replace("|", "\\|")
        index_lines.append(f"| {idx} | {m['date']} | [{safe_title}]({m['filename']}) | `{m['model']}` | {m['messages_count']} |")

    index_file = md_dir / "index.md"
    index_file.write_text("\n".join(index_lines), encoding="utf-8")

    print(f"✅ Hoàn tất! Đã xuất {len(all_meta)} file Markdown và mục lục tại:")
    print(f"   {md_dir}/index.md")


if __name__ == "__main__":
    main()
