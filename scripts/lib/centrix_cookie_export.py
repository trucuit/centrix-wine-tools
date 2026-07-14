#!/usr/bin/env python3
"""
Shared CentriX cookie export pattern (J2TEAM + specials).

Used by:
  - export-pick-service.sh  (from cookies-dump-*.json on disk)
  - export-centrix-api.mjs  (from API snapshot after decrypt)

Output layout (same as historical export-pick-service):
  {out_dir}/{svc_slug}/
    {svc_slug}.json          host-scoped primary (safe inject)
    {svc_slug}.full.json     full jar + meta
    {host}.json              primary host file
    chatgpt.com.json / auth.openai.com.json   (ChatGPT family)
    accounts.x.ai.json                          (Grok family)
    chat.deepseek.com.json / deepseek.storage.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urlparse

# ── Catalog / aliases (single source for both CLIs) ─────────────────────

SERVICE_URLS: dict[str, str] = {
    "chatgpt": "https://chatgpt.com",
    "notebooklm": "https://chatgpt.com",
    "claude": "https://claude.ai",
    "gemini": "https://gemini.google.com",
    "perplexity": "https://www.perplexity.ai",
    "grok": "https://grok.com",
    "grok-heavy": "https://grok.com",
    "microsoft-copilot": "https://copilot.microsoft.com",
    "deepseek": "https://chat.deepseek.com/sign_in",
    "mistral": "https://chat.mistral.ai",
    "midjourney": "https://www.midjourney.com",
    "poe": "https://poe.com",
    "elevenlabs": "https://elevenlabs.io/app",
    "envato-elements": "https://elements.envato.com",
    "gamma": "https://gamma.app",
    "monica": "https://monica.im",
    "semrush": "https://www.semrush.com",
}

# CLI alias → canonical service id (pool slot)
SERVICE_ALIASES: dict[str, str] = {
    "chatgpt": "notebooklm",
    "grok": "grok-heavy",
}

DEEPSEEK_STORAGE_KEYS = (
    "userToken",
    "settingsJwt",
    "__appKit_@deepseek/chat_lastSessionValue",
)


def resolve_service_id(service_id: str) -> str:
    raw = str(service_id or "").strip().lower()
    return SERVICE_ALIASES.get(raw, raw)


def default_url_for_service(service_id: str) -> str:
    sid = str(service_id or "").lower()
    if sid in SERVICE_URLS:
        return SERVICE_URLS[sid]
    if "claude" in sid:
        return "https://claude.ai"
    if "gemini" in sid:
        return "https://gemini.google.com"
    if "grok" in sid:
        return "https://grok.com"
    if "copilot" in sid:
        return "https://copilot.microsoft.com"
    if "deepseek" in sid:
        return "https://chat.deepseek.com/sign_in"
    if "envato" in sid:
        return "https://elements.envato.com"
    if "perplexity" in sid:
        return "https://www.perplexity.ai"
    return "https://chatgpt.com"


def service_slug(service_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", str(service_id or "unknown")).strip("-").lower() or "unknown"


# ── Cookie normalize (Electron / Chromium / dump variants) ──────────────


def cookie_to_j2(c: dict) -> dict | None:
    domain = (c.get("domain") or c.get("host_key") or "").strip()
    if not domain:
        return None
    name = c.get("name") or ""
    if not name:
        return None
    exp = c.get("expirationDate")
    try:
        exp = int(float(exp)) if exp not in (None, "") else None
        if exp and exp > 10**12:
            exp = int(exp / 1000)
    except Exception:
        exp = None
    if exp is None and c.get("expires_utc"):
        try:
            v = int(c["expires_utc"])
            exp = int(v / 1_000_000 - 11644473600) if v > 0 else None
        except Exception:
            pass
    ss = c.get("sameSite")
    if ss is None:
        ss = c.get("samesite")
    if isinstance(ss, int):
        ss = {0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict"}.get(ss, "unspecified")
    ss = str(ss or "unspecified").lower()
    if ss in ("none",):
        ss = "no_restriction"
    secure = bool(c.get("secure") if "secure" in c else c.get("is_secure"))
    http_only = bool(c.get("httpOnly") if "httpOnly" in c else c.get("is_httponly"))
    session = bool(c.get("session")) if "session" in c else (not exp)
    return {
        "domain": domain,
        "expirationDate": exp,
        "hostOnly": not domain.startswith("."),
        "httpOnly": http_only,
        "name": name,
        "path": c.get("path") or "/",
        "sameSite": ss if ss in ("unspecified", "no_restriction", "lax", "strict") else "unspecified",
        "secure": secure,
        "session": session if exp is None else False,
        "storeId": str(c.get("storeId") or "0"),
        "value": "" if c.get("value") is None else str(c.get("value")),
    }


def normalize_cookies(cookies_in: Iterable[dict]) -> list[dict]:
    out: list[dict] = []
    for c in cookies_in or []:
        if not isinstance(c, dict):
            continue
        item = cookie_to_j2(c)
        if item:
            out.append(item)
    return out


def filter_domains(cookies: list[dict], predicates: list[Callable[[str], bool]]) -> list[dict]:
    out = []
    for c in cookies:
        d = c["domain"].lower()
        if any(p(d) for p in predicates):
            out.append(c)
    return out


def write_private_json(path: Path, obj: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def write_j2team(path: Path, page_url: str, cookies: list[dict]) -> Path:
    return write_private_json(path, {"url": page_url, "cookies": cookies})


def extract_deepseek_local_storage(meta: dict) -> dict[str, str]:
    """From dump meta.localStorage or snapshot.storage[] origin items."""
    out: dict[str, str] = {}
    ls = meta.get("localStorage")
    if isinstance(ls, dict):
        for key in DEEPSEEK_STORAGE_KEYS:
            v = ls.get(key)
            if isinstance(v, str) and v:
                out[key] = v
    storage = meta.get("storage")
    if isinstance(storage, list):
        for item in storage:
            if not isinstance(item, dict):
                continue
            loc = item.get("localStorage")
            if not isinstance(loc, dict):
                continue
            for key in DEEPSEEK_STORAGE_KEYS:
                v = loc.get(key)
                if isinstance(v, str) and v and key not in out:
                    out[key] = v
    return out


def parse_input_payload(raw: Any) -> tuple[list[dict], dict]:
    """Return (cookies_raw_list, meta_dict)."""
    if isinstance(raw, list):
        return raw, {}
    if isinstance(raw, dict):
        cookies = raw.get("cookies") or []
        if not isinstance(cookies, list):
            cookies = []
        return cookies, raw
    raise ValueError("invalid dump/snapshot format (need list or {cookies:[...]})")


def write_sidecars(
    *,
    services_dir: Path,
    svc_slug: str,
    source_label: str,
    url: str,
    all_j2: list[dict],
    service_cookies: list[dict],
) -> list[str]:
    """
    Extra files historically written by export-centrix-cookies.sh convert_dump:
      cookies-dump-*.cookies.txt (Netscape)
      cookies-dump-*.cookie-editor.json
      cookies-dump-*.curl.txt
      {slug}.j2team.json (meta + host-scoped cookies)
      cookie-header.{reg}.txt
      {reg}.json (registrable-domain scoped from service cookies)
    """
    written: list[str] = []
    base = f"cookies-dump-{svc_slug}"

    def netscape_lines(cookies: list[dict], title: str) -> str:
        lines = [
            "# Netscape HTTP Cookie File",
            f"# Generated by centrix_cookie_export.py ({title})",
            f"# source: {source_label}",
            "",
        ]
        for item in cookies:
            domain = item["domain"]
            exp = item.get("expirationDate") or 0
            try:
                exp_i = int(exp) if exp else 0
            except Exception:
                exp_i = 0
            lines.append(
                "\t".join(
                    [
                        domain,
                        "TRUE" if domain.startswith(".") else "FALSE",
                        item.get("path") or "/",
                        "TRUE" if item.get("secure") else "FALSE",
                        str(exp_i),
                        item["name"],
                        item["value"],
                    ]
                )
            )
        return "\n".join(lines) + "\n"

    # Netscape + curl + editor use service-scoped cookies (safe)
    ns_path = services_dir / f"{base}.cookies.txt"
    ns_path.parent.mkdir(parents=True, exist_ok=True)
    ns_path.write_text(netscape_lines(service_cookies, "service-scoped"), encoding="utf-8")
    try:
        os.chmod(ns_path, 0o600)
    except OSError:
        pass
    written.append(str(ns_path))

    editor_path = services_dir / f"{base}.cookie-editor.json"
    write_private_json(editor_path, service_cookies)
    written.append(str(editor_path))

    curl_path = services_dir / f"{base}.curl.txt"
    curl_path.write_text(
        "; ".join(f"{c['name']}={c['value']}" for c in service_cookies) + "\n",
        encoding="utf-8",
    )
    try:
        os.chmod(curl_path, 0o600)
    except OSError:
        pass
    written.append(str(curl_path))

    j2team_meta = {
        "url": url,
        "serviceId": svc_slug,
        "serviceName": svc_slug,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "cookies": service_cookies,
    }
    j2_path = services_dir / f"{svc_slug}.j2team.json"
    write_private_json(j2_path, j2team_meta)
    written.append(str(j2_path))

    # Per registrable domain headers + json (from service-scoped cookies)
    from collections import defaultdict

    scoped_by_reg: dict[str, list] = defaultdict(list)
    for c in service_cookies:
        normalized = c["domain"].lstrip(".").lower()
        parts = normalized.split(".")
        reg = ".".join(parts[-2:]) if len(parts) >= 2 else normalized
        scoped_by_reg[reg].append(c)

    for reg, host_cookies in scoped_by_reg.items():
        pairs = [f"{c['name']}={c['value']}" for c in host_cookies]
        hp = services_dir / f"cookie-header.{reg}.txt"
        hp.write_text("; ".join(pairs) + "\n", encoding="utf-8")
        try:
            os.chmod(hp, 0o600)
        except OSError:
            pass
        written.append(str(hp))
        # Only write reg.json if not already written as primary host by main exporter
        # (main writes {host}.json; reg may equal host without subdomain)
        reg_json = services_dir / f"{reg}.json"
        if not reg_json.exists():
            write_j2team(reg_json, f"https://{reg}", host_cookies)
            written.append(str(reg_json))

    return written


def export_service_cookies(
    *,
    service_id: str,
    payload: Any,
    url_hint: str = "",
    out_dir: str | Path,
    j2team_dir: str = "",
    source_label: str = "",
    service_name: str = "",
    sidecars: bool = False,
) -> dict[str, Any]:
    """
    Core shared export. `payload` is either:
      - dump dict {cookies, serviceId, url, localStorage, ...}
      - snapshot dict {cookies, storage, origins, ...}
      - bare cookie list
    """
    cookies_in, meta = parse_input_payload(payload)
    svc_id = str(meta.get("serviceId") or service_id).strip() or service_id
    svc_name = str(service_name or meta.get("serviceName") or svc_id).strip()
    url = (url_hint or meta.get("url") or "").strip()
    if not url:
        url = default_url_for_service(svc_id)
    if not url.startswith("http"):
        url = "https://" + url

    all_j2 = normalize_cookies(cookies_in)
    svc_slug = service_slug(svc_id)
    services_root = Path(out_dir)
    services_dir = services_root / svc_slug
    services_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    host = (urlparse(url).hostname or "").lower()
    host_cookies = filter_domains(
        all_j2,
        [lambda d, h=host: bool(h) and (d.lstrip(".") == h or h.endswith("." + d.lstrip(".")))],
    )
    service_cookies = host_cookies

    # Primary host-scoped
    p_full = services_dir / f"{svc_slug}.json"
    write_j2team(p_full, url, service_cookies)
    written.append(str(p_full))

    # full meta
    meta_out = {
        "url": url,
        "serviceId": svc_id,
        "serviceName": svc_name,
        "exportedAt": meta.get("exportedAt") or datetime.now(timezone.utc).isoformat(),
        "sourceDump": source_label or meta.get("sourceDump") or "",
        "source": meta.get("source") or ("api" if "api" in str(source_label).lower() else "dump"),
        "cookies": all_j2,
    }
    if meta.get("storage") is not None:
        meta_out["storage"] = meta.get("storage")
    if meta.get("origins") is not None:
        meta_out["origins"] = meta.get("origins")
    if meta.get("revision") is not None:
        meta_out["revision"] = meta.get("revision")
    if meta.get("assignedProfile") is not None:
        meta_out["assignedProfile"] = meta.get("assignedProfile")
    write_private_json(services_dir / f"{svc_slug}.full.json", meta_out)

    # ChatGPT family
    is_chatgpt_family = svc_slug in ("chatgpt", "notebooklm") or "chatgpt" in url
    chatgpt_cookies: list[dict] = []
    auth_cookies: list[dict] = []
    if is_chatgpt_family:
        chatgpt_cookies = filter_domains(
            all_j2,
            [
                lambda d: "chatgpt.com" in d,
                lambda d: d.endswith("openai.com")
                and "auth.openai.com" not in d
                and "sentinel.openai.com" not in d,
            ],
        )
        auth_cookies = filter_domains(all_j2, [lambda d: "auth.openai.com" in d])
        if chatgpt_cookies or is_chatgpt_family:
            p = write_j2team(services_dir / "chatgpt.com.json", "https://chatgpt.com", chatgpt_cookies)
            written.append(str(p))
            if svc_slug == "chatgpt":
                write_j2team(services_dir / "chatgpt.json", "https://chatgpt.com", chatgpt_cookies)
        if auth_cookies:
            p = write_j2team(
                services_dir / "auth.openai.com.json",
                "https://auth.openai.com/log-in",
                auth_cookies,
            )
            written.append(str(p))

    # Grok family
    is_grok_family = "grok" in svc_slug or "grok" in url.lower()
    accounts_xai_cookies = filter_domains(
        all_j2,
        [lambda d: d.lstrip(".") in ("x.ai", "accounts.x.ai")],
    )
    if is_grok_family and accounts_xai_cookies:
        p = write_j2team(
            services_dir / "accounts.x.ai.json",
            "https://accounts.x.ai/sign-in",
            accounts_xai_cookies,
        )
        written.append(str(p))

    # DeepSeek family
    is_deepseek_family = "deepseek" in svc_slug or "deepseek" in url.lower()
    deepseek_signin_cookies = filter_domains(
        all_j2,
        [lambda d: d.lstrip(".") in ("deepseek.com", "chat.deepseek.com")],
    )
    if is_deepseek_family and deepseek_signin_cookies:
        p = write_j2team(
            services_dir / "chat.deepseek.com.json",
            "https://chat.deepseek.com/sign_in",
            deepseek_signin_cookies,
        )
        written.append(str(p))

    deepseek_local_storage = extract_deepseek_local_storage(meta) if is_deepseek_family else {}
    if deepseek_local_storage:
        p = write_private_json(
            services_dir / "deepseek.storage.json",
            {"url": "https://chat.deepseek.com", "localStorage": deepseek_local_storage},
        )
        written.append(str(p))

    # Domain-focused host file
    if host and host_cookies:
        page_url = "https://chat.deepseek.com/sign_in" if is_deepseek_family else url
        if not page_url.startswith("http"):
            page_url = f"https://{host}"
        p = write_j2team(services_dir / f"{host}.json", page_url, host_cookies)
        written.append(str(p))

    # Optional external J2TEAM injector tree
    j2team_dir = (j2team_dir or "").strip()
    if j2team_dir:
        j2p = Path(j2team_dir)
        if j2p.is_dir():
            centrix = j2p / "centrix"
            centrix.mkdir(exist_ok=True)
            write_j2team(j2p / f"{svc_slug}.json", url, service_cookies)
            write_j2team(centrix / f"{svc_slug}.json", url, service_cookies)
            if is_chatgpt_family:
                if chatgpt_cookies:
                    write_j2team(j2p / "chatgpt.com.json", "https://chatgpt.com", chatgpt_cookies)
                    write_j2team(centrix / "chatgpt.json", "https://chatgpt.com", chatgpt_cookies)
                    write_j2team(centrix / "chatgpt.pro.json", "https://chatgpt.com", chatgpt_cookies)
                if auth_cookies:
                    write_j2team(
                        j2p / "auth.openai.com.json",
                        "https://auth.openai.com/log-in",
                        auth_cookies,
                    )
            if "claude" in svc_slug:
                write_j2team(centrix / "claude.json", url, service_cookies)
            if "gemini" in svc_slug:
                write_j2team(centrix / "gemini.json", url, service_cookies)
            if is_grok_family and accounts_xai_cookies:
                write_j2team(
                    j2p / "accounts.x.ai.json",
                    "https://accounts.x.ai/sign-in",
                    accounts_xai_cookies,
                )
            if is_deepseek_family and deepseek_signin_cookies:
                write_j2team(
                    j2p / "chat.deepseek.com.json",
                    "https://chat.deepseek.com/sign_in",
                    deepseek_signin_cookies,
                )
                write_j2team(
                    centrix / "chat.deepseek.com.json",
                    "https://chat.deepseek.com/sign_in",
                    deepseek_signin_cookies,
                )
            # Extra centrix aliases (export-centrix-cookies legacy)
            aliases = {
                "chatgpt": ["chatgpt.json", "chatgpt.pro.json"],
                "notebooklm": ["chatgpt.gpt55-pro.json", "gpt-5.5-pro.json"],
                "claude": ["claude.json", "claude.max.json"],
                "gemini": ["gemini.json"],
                "perplexity": ["perplexity.json"],
                "envato-elements": ["envato.json", "envato-elements.json"],
            }
            for key, names in aliases.items():
                if key in svc_slug or svc_slug == key:
                    bare = {"url": url, "cookies": service_cookies}
                    for name in names:
                        write_private_json(centrix / name, bare)

    if sidecars:
        written.extend(
            write_sidecars(
                services_dir=services_dir,
                svc_slug=svc_slug,
                source_label=source_label or "",
                url=url,
                all_j2=all_j2,
                service_cookies=service_cookies,
            )
        )

    return {
        "service": svc_slug,
        "name": svc_name,
        "url": url,
        "cookies": len(all_j2),
        "hostCookies": len(host_cookies),
        "primary": str(p_full),
        "written": written,
        "auth_cookies": len(auth_cookies) if is_chatgpt_family else None,
        "chatgpt_domain_cookies": len(chatgpt_cookies) if is_chatgpt_family else None,
        "accounts_xai_cookies": len(accounts_xai_cookies) if is_grok_family else None,
        "deepseek_signin_cookies": len(deepseek_signin_cookies) if is_deepseek_family else None,
        "deepseek_local_storage_keys": len(deepseek_local_storage) if deepseek_local_storage else None,
    }


def export_from_dump_file(
    *,
    service_id: str,
    dump_path: str | Path,
    url_hint: str = "",
    out_dir: str | Path,
    j2team_dir: str = "",
    sidecars: bool = False,
) -> dict[str, Any]:
    path = Path(dump_path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    return export_service_cookies(
        service_id=service_id,
        payload=raw,
        url_hint=url_hint,
        out_dir=out_dir,
        j2team_dir=j2team_dir,
        source_label=str(path),
        sidecars=sidecars,
    )


def _print_result(result: dict[str, Any]) -> None:
    print(f"service={result['service']}")
    print(f"name={result['name']}")
    print(f"url={result['url']}")
    print(f"cookies={result['cookies']}")
    print(f"primary={result['primary']}")
    for key in (
        "auth_cookies",
        "chatgpt_domain_cookies",
        "accounts_xai_cookies",
        "deepseek_signin_cookies",
        "deepseek_local_storage_keys",
    ):
        if result.get(key) is not None:
            print(f"{key}={result[key]}")
    for w in result.get("written") or []:
        print(f"wrote={w}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Shared CentriX cookie export (J2TEAM pattern)")
    p.add_argument("--service", "-s", required=True, help="service id (aliases: chatgpt, grok)")
    p.add_argument("--dump", "-d", help="path to cookies-dump / snapshot JSON")
    p.add_argument("--stdin", action="store_true", help="read JSON payload from stdin")
    p.add_argument("--url", default="", help="url hint")
    p.add_argument("--out-dir", "-o", required=True, help="output cookies root")
    p.add_argument("--j2team-dir", default="", help="optional external injector copy dir")
    p.add_argument("--source", default="", help="source label for .full.json")
    p.add_argument("--name", default="", help="service display name")
    p.add_argument(
        "--sidecars",
        action="store_true",
        help="also write netscape/curl/editor/j2team/cookie-header (export-centrix-cookies style)",
    )
    p.add_argument("--json", action="store_true", help="print machine JSON summary on stdout")
    args = p.parse_args(argv)

    sid = resolve_service_id(args.service)
    if args.stdin:
        payload = json.load(sys.stdin)
        result = export_service_cookies(
            service_id=sid,
            payload=payload,
            url_hint=args.url,
            out_dir=args.out_dir,
            j2team_dir=args.j2team_dir,
            source_label=args.source or "stdin",
            service_name=args.name,
            sidecars=args.sidecars,
        )
    elif args.dump:
        result = export_from_dump_file(
            service_id=sid,
            dump_path=args.dump,
            url_hint=args.url,
            out_dir=args.out_dir,
            j2team_dir=args.j2team_dir,
            sidecars=args.sidecars,
        )
    else:
        p.error("need --dump or --stdin")
        return 2

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        _print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
