#!/usr/bin/env python3
"""
convert_conversations_to_html.py

Convert ChatGPT conversation JSON files to self-contained HTML files.
Images use absolute file:// paths for guaranteed loading in any browser.

Usage:
    python3 convert_conversations_to_html.py <conversations_dir> [assets_dir]
"""
import json
import sys
import os
import re
import html as html_lib
from pathlib import Path
from datetime import datetime


def timestamp_to_str(ts):
    if not ts:
        return "?"
    try:
        if isinstance(ts, str):
            return ts[:19]
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts)[:19]


def role_emoji(role: str) -> str:
    return {"user": "👤", "assistant": "🤖", "system": "⚙️", "tool": "🔧"}.get(role, "❓")


def role_label(role: str) -> str:
    return {"user": "User", "assistant": "ChatGPT", "system": "System", "tool": "Tool"}.get(role, role)


# ─── Asset resolution ────────────────────────────────────────────────────

def load_asset_manifest(assets_dir: Path, conv_id: str) -> dict:
    """Build file_id → absolute file:// URL mapping.
    Searches daily subdirs (YYYY-MM-DD/*_cid8/)."""
    mapping = {}
    if not assets_dir or not conv_id:
        return mapping

    cid8 = conv_id[:8]
    candidates = []

    # Daily subdirs
    for d in assets_dir.iterdir():
        if d.is_dir() and re.match(r'^\d{4}-\d{2}-\d{2}$', d.name):
            for sub in d.iterdir():
                if sub.is_dir() and sub.name.endswith(cid8):
                    fc = sum(1 for f in sub.iterdir() if f.is_file() and not f.name.startswith("_"))
                    candidates.append((sub, fc))

    # Flat fallback
    for sub in assets_dir.iterdir():
        if sub.is_dir() and not re.match(r'^\d{4}-\d{2}-\d{2}$', sub.name):
            if sub.name.endswith(cid8) or sub.name == conv_id:
                fc = sum(1 for f in sub.iterdir() if f.is_file() and not f.name.startswith("_"))
                candidates.append((sub, fc))

    if not candidates:
        return mapping

    candidates.sort(key=lambda x: x[1], reverse=True)
    asset_dir = candidates[0][0]

    # Manifest
    manifest = asset_dir / "_manifest.json"
    if manifest.exists():
        try:
            items = json.loads(manifest.read_text(encoding="utf-8"))
            for item in items:
                fid = item.get("file_id", "")
                local = item.get("local_path", "")
                if fid and local and os.path.isfile(local):
                    mapping[fid] = Path(local).resolve().as_uri()
        except Exception:
            pass

    # Index all files by stem and name
    for f in asset_dir.iterdir():
        if f.name.startswith("_") or not f.is_file():
            continue
        uri = f.resolve().as_uri()
        mapping[f.stem] = uri
        mapping[f.name] = uri

    return mapping


# ─── Citation cleanup ─────────────────────────────────────────────────────

def clean_citations(text: str, metadata: dict = None) -> str:
    if not text:
        return text
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
                        title = items[0].get("title") or "source"
                        url = items[0].get("url")
                        text = text.replace(matched, f' <a href="{url}">{title}</a> ')
                    else:
                        text = text.replace(matched, "")
    text = re.sub(r"[\ue200-\ue205][^\ue200-\ue205\n]*[\ue200-\ue205]", "", text)
    text = re.sub(r"[\ue200-\ue205]", "", text)
    text = re.sub(r" +([.,!?:;])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


# ─── Markdown → HTML (lightweight) ───────────────────────────────────────

def md_to_html(text: str) -> str:
    """Minimal markdown to HTML conversion for message bodies."""
    if not text.strip():
        return ""

    lines = text.split("\n")
    html_parts = []
    in_code = False
    code_lang = ""
    code_buf = []
    in_list = False

    for line in lines:
        # Fenced code blocks
        if re.match(r'^```', line):
            if in_code:
                code_content = html_lib.escape("\n".join(code_buf))
                cls = f' class="language-{code_lang}"' if code_lang else ""
                html_parts.append(f'<pre><code{cls}>{code_content}</code></pre>')
                code_buf = []
                in_code = False
                code_lang = ""
            else:
                if in_list:
                    html_parts.append("</ul>")
                    in_list = False
                in_code = True
                code_lang = line[3:].strip()
            continue

        if in_code:
            code_buf.append(line)
            continue

        # Empty line
        if not line.strip():
            if in_list:
                html_parts.append("</ul>")
                in_list = False
            continue

        # Headers
        hm = re.match(r'^(#{1,6})\s+(.*)', line)
        if hm:
            if in_list:
                html_parts.append("</ul>")
                in_list = False
            level = len(hm.group(1))
            html_parts.append(f'<h{level}>{_inline_md(hm.group(2))}</h{level}>')
            continue

        # Unordered list
        lm = re.match(r'^[-*]\s+(.*)', line)
        if lm:
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
            html_parts.append(f'<li>{_inline_md(lm.group(1))}</li>')
            continue

        # Ordered list
        om = re.match(r'^\d+\.\s+(.*)', line)
        if om:
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
            html_parts.append(f'<li>{_inline_md(om.group(1))}</li>')
            continue

        if in_list:
            html_parts.append("</ul>")
            in_list = False

        # Regular paragraph
        html_parts.append(f'<p>{_inline_md(line)}</p>')

    if in_code:
        code_content = html_lib.escape("\n".join(code_buf))
        html_parts.append(f'<pre><code>{code_content}</code></pre>')
    if in_list:
        html_parts.append("</ul>")

    return "\n".join(html_parts)


def _inline_md(text: str) -> str:
    """Convert inline markdown: bold, italic, code, links, images."""
    # Images ![alt](src)
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img src="\2" alt="\1" loading="lazy">', text)
    # Links [text](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    # Bold **text**
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # Italic *text*
    text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
    # Inline code `text`
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    return text


# ─── Extract text from parts → HTML ──────────────────────────────────────

def extract_parts_html(parts: list, asset_map: dict) -> str:
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
                uri = asset_map.get(file_id, "")
                if uri:
                    result.append(f'\n![Image ({w}x{h})]({uri})\n')
                else:
                    result.append(f'\n> 🖼️ *Image ({w}x{h})* — `{file_id[:30]}…`\n')

            elif ct == "multimodal_text":
                sub = extract_parts_html(part.get("parts", []), asset_map)
                if sub:
                    result.append(sub)

            elif ct == "code":
                lang = part.get("language", "")
                text = part.get("text", "")
                if text:
                    result.append(f'\n```{lang}\n{text}\n```\n')

            elif ct == "execution_output":
                text = part.get("text", "")
                if text:
                    result.append(f'\n```\n{text}\n```\n')

            elif ct == "tether_browsing_display":
                result.append('\n> 🌐 *Browsing result*\n')

            elif ct == "tether_quote":
                title = part.get("title", "")
                url = part.get("url", "")
                text = part.get("text", "")
                result.append(f'\n> 📎 [{title}]({url})\n> {text[:200]}\n')

            else:
                text = part.get("text", "")
                if text:
                    result.append(text)

    return "\n".join(result)


# ─── Walk tree ────────────────────────────────────────────────────────────

def walk_conversation(mapping: dict, root_id: str) -> list:
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


# ─── CSS ──────────────────────────────────────────────────────────────────

CSS = """
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
  --user-bg: #1c2333; --user-border: #3b82f6;
  --bot-bg: #161b22; --bot-border: #30363d;
  --code-bg: #1e2430; --link: #58a6ff;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fff; --surface: #f6f8fa; --border: #d0d7de;
    --text: #1f2328; --text2: #656d76; --accent: #0969da;
    --user-bg: #dbeafe; --user-border: #3b82f6;
    --bot-bg: #f6f8fa; --bot-border: #d0d7de;
    --code-bg: #f0f2f5; --link: #0969da;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text);
  max-width: 860px; margin: 0 auto; padding: 24px 20px;
  line-height: 1.65;
}
h1 { font-size: 1.8rem; margin-bottom: 8px; }
.meta { color: var(--text2); font-size: 0.85rem; margin-bottom: 20px; padding: 12px 16px;
  background: var(--surface); border-radius: 8px; border: 1px solid var(--border); }
.meta code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.82rem; }
hr { border: none; border-top: 1px solid var(--border); margin: 4px 0; }

/* Messages */
.msg { padding: 16px 20px; border-radius: 12px; margin: 12px 0; border-left: 4px solid; }
.msg-user { background: var(--user-bg); border-left-color: var(--user-border); }
.msg-assistant { background: var(--bot-bg); border-left-color: var(--bot-border); }
.msg-system, .msg-tool { background: var(--surface); border-left-color: var(--text2); }
.msg-header { font-weight: 600; font-size: 0.9rem; margin-bottom: 10px; color: var(--text2); }
.msg-header .role { color: var(--accent); }

/* Content */
.msg p { margin: 6px 0; }
.msg h1, .msg h2, .msg h3, .msg h4 { margin: 14px 0 6px; }
.msg ul, .msg ol { padding-left: 24px; margin: 6px 0; }
.msg li { margin: 3px 0; }
.msg a { color: var(--link); text-decoration: none; }
.msg a:hover { text-decoration: underline; }
.msg code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.88em;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
.msg pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px; margin: 10px 0;
  overflow-x: auto; border: 1px solid var(--border); }
.msg pre code { background: none; padding: 0; font-size: 0.85rem; line-height: 1.5; }
.msg img { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; display: block;
  border: 1px solid var(--border); }
.msg blockquote { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 8px 0;
  color: var(--text2); }

/* Attachments */
.attachment { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
  background: var(--code-bg); border-radius: 6px; font-size: 0.85rem; margin: 4px 4px 4px 0; }
.attachment img { max-width: 200px; border-radius: 6px; }

/* Footer */
.footer { text-align: center; color: var(--text2); font-size: 0.82rem; margin-top: 30px; padding-top: 16px;
  border-top: 1px solid var(--border); }
"""


# ─── Convert one conversation ────────────────────────────────────────────

def convert_conversation_html(json_path: Path, assets_dir: Path = None) -> str:
    with open(json_path) as f:
        data = json.load(f)

    title = data.get("title", "Untitled")
    conv_id = data.get("conversation_id", json_path.stem)
    created = timestamp_to_str(data.get("create_time"))
    updated = timestamp_to_str(data.get("update_time"))
    model = data.get("default_model_slug", "?")
    mapping = data.get("mapping", {})

    root_id = None
    for mid, node in mapping.items():
        if node.get("parent") is None:
            root_id = mid
            break

    if not root_id:
        return f"<html><body><h1>{html_lib.escape(title)}</h1><p>Empty conversation</p></body></html>"

    messages = walk_conversation(mapping, root_id)
    asset_map = load_asset_manifest(assets_dir, conv_id) if assets_dir else {}

    # Build HTML
    parts = []
    parts.append(f"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html_lib.escape(title)}</title>
<style>{CSS}</style>
</head>
<body>
<h1>{html_lib.escape(title)}</h1>
<div class="meta">
  <strong>Model:</strong> <code>{html_lib.escape(model)}</code> ·
  <strong>Created:</strong> {html_lib.escape(created)} ·
  <strong>Updated:</strong> {html_lib.escape(updated)}<br>
  <strong>ID:</strong> <code>{html_lib.escape(conv_id)}</code>
</div>
<hr>""")

    msg_count = 0
    for msg in messages:
        role = msg.get("author", {}).get("role", "unknown")
        content = msg.get("content", {})
        msg_parts = content.get("parts", [])
        metadata = msg.get("metadata", {})
        model_slug = metadata.get("model_slug", "")
        msg_time = timestamp_to_str(msg.get("create_time"))

        raw_text = extract_parts_html(msg_parts, asset_map)
        raw_text = clean_citations(raw_text, metadata)

        if not raw_text.strip() and role in ("system", "tool"):
            continue
        if not raw_text.strip() and role == "assistant":
            if not metadata.get("thinking", ""):
                continue

        msg_count += 1
        emoji = role_emoji(role)
        label = role_label(role)
        model_info = f' <code>{html_lib.escape(model_slug)}</code>' if model_slug and role == "assistant" else ""
        time_info = f' · {html_lib.escape(msg_time)}' if msg_time != "?" else ""

        body_html = md_to_html(raw_text)

        parts.append(f'<div class="msg msg-{role}">')
        parts.append(f'  <div class="msg-header"><span class="role">{emoji} {label}</span>{model_info}{time_info}</div>')
        if body_html:
            parts.append(f'  <div class="msg-body">{body_html}</div>')

        # Attachments
        attachments = metadata.get("attachments", [])
        for att in attachments:
            name = att.get("name", "file")
            mime = att.get("mime_type", "")
            fid = att.get("id", "")
            uri = (asset_map.get(fid, "") or asset_map.get(name, "")
                   or asset_map.get(os.path.splitext(name)[0], ""))
            if uri:
                if mime.startswith("image/"):
                    parts.append(f'  <div class="attachment"><img src="{uri}" alt="{html_lib.escape(name)}"></div>')
                else:
                    parts.append(f'  <div class="attachment">📎 <a href="{uri}">{html_lib.escape(name)}</a> <code>{html_lib.escape(mime)}</code></div>')
            else:
                parts.append(f'  <div class="attachment">📎 {html_lib.escape(name)} <code>{html_lib.escape(mime)}</code></div>')

        parts.append('</div>')

    parts.append(f'<div class="footer">{msg_count} messages · {len(mapping)} nodes</div>')
    parts.append('</body></html>')
    return "\n".join(parts)


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <conversations_dir> [assets_dir]")
        sys.exit(1)

    conv_dir = Path(sys.argv[1])
    assets_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    html_dir = conv_dir.parent / "conversations_html"
    html_dir.mkdir(parents=True, exist_ok=True)

    # Collect all JSON files
    file_meta = []
    json_files = list(conv_dir.glob("*.json")) + list(conv_dir.glob("*/*.json"))
    for jf in json_files:
        if jf.name.startswith("_"):
            continue
        try:
            with open(jf) as f:
                d = json.load(f)
            ct = d.get("create_time", 0)
            if isinstance(ct, str):
                ct = 0
            file_meta.append((jf, d.get("title", "Untitled"), ct, d))
        except Exception:
            file_meta.append((jf, "Untitled", 0, {}))

    file_meta.sort(key=lambda x: x[2], reverse=True)

    if not file_meta:
        print(f"❌ Không tìm thấy file JSON trong {conv_dir}")
        sys.exit(1)

    print(f"\n\033[1m\033[36m{'═' * 60}\033[0m")
    print(f"\033[1m🌐 Converting {len(file_meta)} conversations → HTML\033[0m")
    print(f"\033[1m\033[36m{'═' * 60}\033[0m\n")

    ok = 0
    converted = []
    for i, (jf, title, ct, data) in enumerate(file_meta):
        try:
            safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title).strip()[:35]
            safe_title = re.sub(r"_+", "_", safe_title).strip("_")
            try:
                date_prefix = datetime.fromtimestamp(ct).strftime("%Y-%m-%d_%H%M")
                day_dir_name = datetime.fromtimestamp(ct).strftime("%Y-%m-%d")
            except Exception:
                date_prefix = "0000-00-00_0000"
                day_dir_name = "0000-00-00"

            html_day_dir = html_dir / day_dir_name
            html_day_dir.mkdir(parents=True, exist_ok=True)

            html_content = convert_conversation_html(jf, assets_dir)
            html_file = html_day_dir / f"{date_prefix}_{safe_title}.html"
            html_file.write_text(html_content, encoding="utf-8")
            ok += 1

            model = data.get("default_model_slug", "?")
            msg_count = len(data.get("mapping", {}))
            created = timestamp_to_str(ct)
            rel_path = f"{day_dir_name}/{html_file.name}"
            converted.append((i + 1, title, model, msg_count, created, rel_path))

            print(f"  \033[32m✓\033[0m [{i+1}/{len(file_meta)}] {created} │ {title[:40]} → {rel_path}")
        except Exception as e:
            print(f"  \033[31m✗\033[0m [{i+1}/{len(file_meta)}] {jf.name} — {e}")

    print(f"\n\033[1m\033[32m🎉 {ok}/{len(file_meta)} converted → {html_dir}/\033[0m")

    # Create index.html
    idx = []
    idx.append(f"""<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChatGPT Conversations</title>
<style>{CSS}
table {{ width: 100%; border-collapse: collapse; }}
th, td {{ text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }}
th {{ color: var(--accent); font-weight: 600; position: sticky; top: 0; background: var(--bg); }}
tr:hover {{ background: var(--surface); }}
a {{ color: var(--link); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
</style></head><body>
<h1>📚 ChatGPT Conversations</h1>
<div class="meta">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · <strong>{len(file_meta)}</strong> conversations · Sorted: newest first</div>
<table><thead><tr><th>#</th><th>Date</th><th>Title</th><th>Model</th><th>Msgs</th></tr></thead><tbody>""")

    for i, (num, title, model, mc, created, rp) in enumerate(converted):
        idx.append(f'<tr><td>{num}</td><td>{created}</td><td><a href="{rp}">{html_lib.escape(title[:50])}</a></td><td><code>{html_lib.escape(model)}</code></td><td>{mc}</td></tr>')

    idx.append("</tbody></table></body></html>")
    (html_dir / "index.html").write_text("\n".join(idx), encoding="utf-8")
    print(f"\033[32m✅ Index → {html_dir}/index.html\033[0m")


if __name__ == "__main__":
    main()
