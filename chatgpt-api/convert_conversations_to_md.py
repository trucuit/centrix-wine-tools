#!/usr/bin/env python3
"""
convert_conversations_to_md.py

Convert ChatGPT conversation JSON files to beautiful Markdown files.
Embeds images, formats messages, and creates a visual conversation flow.

Usage:
    python3 convert_conversations_to_md.py <conversations_dir> [assets_dir]
"""
import json
import sys
import os
import re
from pathlib import Path
from datetime import datetime


def timestamp_to_str(ts):
    """Convert Unix timestamp to readable string."""
    if not ts:
        return "?"
    try:
        if isinstance(ts, str):
            return ts[:19]
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts)[:19]


def role_emoji(role: str) -> str:
    return {
        "user": "👤",
        "assistant": "🤖",
        "system": "⚙️",
        "tool": "🔧",
    }.get(role, "❓")


def role_label(role: str) -> str:
    return {
        "user": "User",
        "assistant": "ChatGPT",
        "system": "System",
        "tool": "Tool",
    }.get(role, role)


def load_asset_manifest(assets_dir: Path, conv_id: str, md_dir: Path = None) -> dict:
    """Load _manifest.json and build file_id → relative_path mapping."""
    mapping = {}
    if not assets_dir or not conv_id:
        return mapping

    def _to_path(abs_path: str) -> str:
        """Convert absolute path to relative path from md_dir."""
        if md_dir:
            return os.path.relpath(abs_path, str(md_dir))
        return abs_path

    manifest_path = assets_dir / conv_id / "_manifest.json"
    if manifest_path.exists():
        try:
            with open(manifest_path) as f:
                items = json.load(f)
            for item in items:
                fid = item.get("file_id", "")
                local = item.get("local_path", "")
                if fid and local and os.path.isfile(local):
                    mapping[fid] = _to_path(os.path.abspath(local))
        except Exception:
            pass

    # Also index all files in the directory by filename
    asset_conv_dir = assets_dir / conv_id
    if asset_conv_dir.exists():
        for f in asset_conv_dir.iterdir():
            if f.name.startswith("_") or not f.is_file():
                continue
            resolved = str(f.resolve())
            mapping[f.stem] = _to_path(resolved)
            mapping[f.name] = _to_path(resolved)

    return mapping


def clean_citations(text: str, metadata: dict = None) -> str:
    """Clean ChatGPT citation markers and replace with markdown links or remove."""
    if not text:
        return text

    # First replace from content_references if available
    if metadata and "content_references" in metadata:
        for ref in metadata.get("content_references", []):
            matched = ref.get("matched_text")
            alt = ref.get("alt")
            if matched and matched.strip() and matched in text:
                if alt and alt.strip():
                    text = text.replace(matched, f" {alt.strip()} ")
                else:
                    items = ref.get("items", [])
                    if items and items[0].get("url"):
                        title = items[0].get("title") or items[0].get("attribution") or "source"
                        url = items[0].get("url")
                        text = text.replace(matched, f" [{title}]({url}) ")
                    else:
                        text = text.replace(matched, "")

    # Remove any remaining raw citation tokens (\ue200...\ue201, \ue200cite..., etc.)
    text = re.sub(r"[\ue200-\ue205][^\ue200-\ue205\n]*[\ue200-\ue205]", "", text)
    text = re.sub(r"[\ue200-\ue205]", "", text)
    text = re.sub(r" +([.,!?:;])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def extract_text_from_parts(parts: list, asset_map: dict = None) -> str:
    """Extract text and image references from message parts."""
    if asset_map is None:
        asset_map = {}
    result = []
    for part in parts:
        if isinstance(part, str):
            if part.strip():
                result.append(part)
        elif isinstance(part, dict):
            ct = part.get("content_type", "")
            if ct == "image_asset_pointer":
                pointer = part.get("asset_pointer", "")
                file_id = pointer.replace("sediment://", "")
                w = part.get("width", "?")
                h = part.get("height", "?")

                # Look up in asset map
                local_path = asset_map.get(file_id, "")
                if local_path:
                    result.append(f"\n![Image ({w}x{h})]({local_path})\n")
                else:
                    result.append(f"\n> 🖼️ *Image ({w}x{h})* — `{file_id[:30]}…`\n")

            elif ct == "multimodal_text":
                # Nested parts
                sub_parts = part.get("parts", [])
                sub_text = extract_text_from_parts(sub_parts, asset_map)
                if sub_text:
                    result.append(sub_text)

            elif ct == "code":
                lang = part.get("language", "")
                text = part.get("text", "")
                if text:
                    result.append(f"\n```{lang}\n{text}\n```\n")

            elif ct == "execution_output":
                text = part.get("text", "")
                if text:
                    result.append(f"\n<details><summary>📋 Output</summary>\n\n```\n{text}\n```\n</details>\n")

            elif ct == "tether_browsing_display":
                result.append(f"\n> 🌐 *Browsing result*\n")

            elif ct == "tether_quote":
                title = part.get("title", "")
                url = part.get("url", "")
                text = part.get("text", "")
                result.append(f"\n> 📎 [{title}]({url})\n> {text[:200]}\n")

            else:
                text = part.get("text", "")
                if text:
                    result.append(text)

    return "\n".join(result)


def walk_conversation(mapping: dict, root_id: str) -> list:
    """Walk the conversation tree in order, returning a flat list of messages."""
    messages = []

    def _walk(node_id):
        node = mapping.get(node_id, {})
        msg = node.get("message")
        if msg:
            messages.append(msg)
        for child_id in node.get("children", []):
            _walk(child_id)

    _walk(root_id)
    return messages


def convert_conversation(json_path: Path, assets_dir: Path = None, md_dir: Path = None) -> str:
    """Convert a single conversation JSON to Markdown."""
    with open(json_path) as f:
        data = json.load(f)

    title = data.get("title", "Untitled")
    conv_id = data.get("conversation_id", json_path.stem)
    created = timestamp_to_str(data.get("create_time"))
    updated = timestamp_to_str(data.get("update_time"))
    model = data.get("default_model_slug", "?")
    mapping = data.get("mapping", {})

    # Find root
    root_id = None
    for mid, node in mapping.items():
        if node.get("parent") is None:
            root_id = mid
            break

    if not root_id:
        return f"# {title}\n\n*Empty conversation*\n"

    messages = walk_conversation(mapping, root_id)

    # Load asset manifest for this conversation
    asset_map = load_asset_manifest(assets_dir, conv_id, md_dir) if assets_dir else {}

    # Build markdown
    lines = []
    lines.append(f"# {title}\n")
    lines.append(f"> **Model:** `{model}` · **Created:** {created} · **Updated:** {updated}")
    lines.append(f"> **ID:** `{conv_id}`\n")
    lines.append("""<style>
blockquote {
  background-color: rgba(59, 130, 246, 0.08) !important;
  border-left: 4px solid #3b82f6 !important;
  padding: 12px 18px !important;
  border-radius: 8px !important;
  margin: 16px 0 !important;
  color: inherit !important;
}
blockquote h3 {
  margin-top: 0 !important;
  color: #60a5fa !important;
}
</style>\n""")
    lines.append("---\n")

    msg_count = 0
    for msg in messages:
        role = msg.get("author", {}).get("role", "unknown")
        content = msg.get("content", {})
        parts = content.get("parts", [])
        ct = content.get("content_type", "text")
        metadata = msg.get("metadata", {})
        model_slug = metadata.get("model_slug", "")
        msg_time = timestamp_to_str(msg.get("create_time"))

        # Skip empty system/tool messages
        text = extract_text_from_parts(parts, asset_map)
        text = clean_citations(text, metadata)
        if not text.strip() and role in ("system", "tool"):
            continue
        if not text.strip() and role == "assistant":
            # Check if it's a thinking step (empty content but has thoughts)
            thoughts = metadata.get("thinking", "")
            if not thoughts:
                continue

        msg_count += 1
        emoji = role_emoji(role)
        label = role_label(role)

        # Format header
        model_info = f" `{model_slug}`" if model_slug and role == "assistant" else ""
        time_info = f" · {msg_time}" if msg_time != "?" else ""

        if role == "user":
            lines.append(f"> ### {emoji} {label}{time_info}\n>")
            if text.strip():
                user_content = "\n".join(f"> {l}" if l.strip() else ">" for l in text.splitlines())
                lines.append(f"{user_content}\n")
            else:
                lines.append(">\n")
        elif role == "assistant":
            lines.append(f"### {emoji} {label}{model_info}{time_info}\n")
            if text.strip():
                lines.append(f"{text}\n")
        elif role == "tool":
            lines.append(f"### {emoji} Tool{time_info}\n")
            if text.strip():
                lines.append(f"<details><summary>Tool output</summary>\n\n{text}\n</details>\n")
        else:
            lines.append(f"### {emoji} {label}{time_info}\n")
            if text.strip():
                lines.append(f"{text}\n")

        # Attachments
        attachments = metadata.get("attachments", [])
        pfx = "> " if role == "user" else ""
        for att in attachments:
            name = att.get("name", "file")
            mime = att.get("mime_type", "")
            fid = att.get("id", "")

            # Look up in asset map by file_id, name, or stem
            local_file = (
                asset_map.get(fid, "")
                or asset_map.get(name, "")
                or asset_map.get(os.path.splitext(name)[0], "")
            )

            if local_file:
                if mime.startswith("image/"):
                    lines.append(f"{pfx}![{name}]({local_file})\n")
                else:
                    lines.append(f"{pfx}📎 [{name}]({local_file}) `{mime}`\n")
            else:
                lines.append(f"{pfx}📎 *{name}* (`{mime}`) — `{fid[:20]}…`\n")

        lines.append("---\n")

    lines.append(f"\n*{msg_count} messages · {len(mapping)} nodes*\n")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <conversations_dir> [assets_dir]")
        sys.exit(1)

    conv_dir = Path(sys.argv[1])
    assets_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    md_dir = conv_dir.parent / "conversations_md"
    md_dir.mkdir(parents=True, exist_ok=True)

    # Pre-load metadata and sort by create_time (newest first)
    file_meta = []
    for jf in conv_dir.glob("*.json"):
        try:
            with open(jf) as f:
                d = json.load(f)
            ct = d.get("create_time", 0)
            if isinstance(ct, str):
                ct = 0
            file_meta.append((jf, d.get("title", "Untitled"), ct, d))
        except Exception:
            file_meta.append((jf, "Untitled", 0, {}))

    # Sort newest first
    file_meta.sort(key=lambda x: x[2], reverse=True)

    if not file_meta:
        print(f"❌ Không tìm thấy file JSON trong {conv_dir}")
        sys.exit(1)

    print(f"\n\033[1m\033[36m{'═' * 60}\033[0m")
    print(f"\033[1m📄 Converting {len(file_meta)} conversations → Markdown (newest first)\033[0m")
    print(f"\033[1m\033[36m{'═' * 60}\033[0m\n")

    ok = 0
    converted = []  # (index, title, model, msg_count, created, md_name)
    for i, (jf, title, ct, data) in enumerate(file_meta):
        try:
            md_content = convert_conversation(jf, assets_dir, md_dir)

            safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title).strip()[:35]
            safe_title = re.sub(r"_+", "_", safe_title).strip("_")
            # Date prefix for file explorer sorting (newest first with reverse sort)
            try:
                date_prefix = datetime.fromtimestamp(ct).strftime("%Y-%m-%d_%H%M")
            except Exception:
                date_prefix = "0000-00-00_0000"
            md_file = md_dir / f"{date_prefix}_{safe_title}.md"

            md_file.write_text(md_content, encoding="utf-8")
            ok += 1

            model = data.get("default_model_slug", "?")
            msg_count = len(data.get("mapping", {}))
            created = timestamp_to_str(ct)
            converted.append((i + 1, title, model, msg_count, created, md_file.name))

            print(f"  \033[32m✓\033[0m [{i+1}/{len(file_meta)}] {created} │ {title[:40]} → {md_file.name}")
        except Exception as e:
            print(f"  \033[31m✗\033[0m [{i+1}/{len(file_meta)}] {jf.name} — {e}")

    print(f"\n\033[1m\033[32m🎉 {ok}/{len(file_meta)} converted → {md_dir}/\033[0m")

    # Create index.md (sorted newest first)
    index_lines = ["# 📚 ChatGPT Conversations Index\n"]
    index_lines.append(f"> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · Sorted: **newest first**\n")
    index_lines.append("| # | Date | Title | Model | Messages |")
    index_lines.append("|---|------|-------|-------|----------|")

    for idx, title, model, msg_count, created, md_name in converted:
        index_lines.append(
            f"| {idx} | {created} | [{title[:40]}]({md_name}) | `{model}` | {msg_count} |")

    index_lines.append(f"\n*{len(file_meta)} conversations*\n")
    (md_dir / "index.md").write_text("\n".join(index_lines), encoding="utf-8")
    print(f"\033[32m✅ Index → {md_dir}/index.md\033[0m")


if __name__ == "__main__":
    main()
