"""Archive the public DeepSeek documentation without third-party dependencies.

Run from the repository root with Python 3.11+; network access is required.
Only the official documentation host and its CDN images are fetched.
Completed snapshots are immutable.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import posixpath
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

HOST = "https://api-docs.deepseek.com"
ROUTES = ("/api/", "/guides/", "/quick_start/", "/news/", "/updates")


def normalized(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/") or "/", "", ""))


def allowed_url(url: str) -> bool:
    parts = urllib.parse.urlsplit(url)
    return parts.scheme == "https" and (parts.netloc == "api-docs.deepseek.com" or (
        parts.netloc == "cdn.deepseek.com" and parts.path.startswith("/api-docs/")
    ))


def fetch(url: str) -> tuple[bytes, dict]:
    if not allowed_url(url):
        raise ValueError(f"Outside the official documentation host: {url}")
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "deepseek-app-docs-archive/1.0"})
            with urllib.request.urlopen(request, timeout=45) as response:
                if not allowed_url(response.url):
                    raise ValueError(f"Unexpected redirect: {response.url}")
                body = response.read()
                return body, {
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                    "response_url": response.url,
                    "http_status": response.status,
                    "content_type": response.headers.get("Content-Type", ""),
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "bytes": len(body),
                }
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("unreachable")


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonical = ""
        self.markdown = ""
        self.links: set[str] = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical = attrs.get("href", "")
        if tag == "a" and attrs.get("href"):
            self.links.add(attrs["href"])
            if "doc-markdown-link" in attrs.get("class", "").split():
                self.markdown = attrs["href"]


def is_doc_page(url: str) -> bool:
    parts = urllib.parse.urlsplit(url)
    path = parts.path.removeprefix("/zh-cn")
    return parts.netloc == "api-docs.deepseek.com" and (
        path in ("", "/") or path.startswith(ROUTES)
    ) and not Path(path).suffix


def local_page(url: str) -> str:
    path = urllib.parse.urlsplit(url).path.strip("/")
    locale = "zh-cn" if path == "zh-cn" or path.startswith("zh-cn/") else "en"
    if locale == "zh-cn":
        path = path.removeprefix("zh-cn").strip("/")
    return f"pages/{locale}/{path or 'index'}.md"


def write(root: Path, relative: str, data: bytes) -> str:
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe archive path: {relative}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return relative


def archive_page(url: str) -> tuple[dict, str, set[str]]:
    html, html_meta = fetch(url)
    parser = PageLinks()
    parser.feed(html.decode("utf-8"))
    canonical = normalized(urllib.parse.urljoin(url, parser.canonical))
    if canonical != normalized(url):
        # Some official CDN paths return the homepage without a trailing slash.
        html, html_meta = fetch(url.rstrip("/") + "/")
        parser = PageLinks()
        parser.feed(html.decode("utf-8"))
        canonical = normalized(urllib.parse.urljoin(url, parser.canonical))
    if canonical != normalized(url):
        raise ValueError(f"Canonical mismatch / possible soft 404: {url} -> {canonical}")
    if not parser.markdown:
        raise ValueError(f"No official Markdown download link: {url}")
    markdown_url = urllib.parse.urljoin(url, parser.markdown)
    raw, meta = fetch(markdown_url)
    text = raw.decode("utf-8")
    if text.lstrip().lower().startswith(("<!doctype", "<html")) or not text.lstrip().startswith("# "):
        raise ValueError(f"Markdown endpoint returned HTML / unexpected content: {markdown_url}")
    path = local_page(url)
    entry = {"url": url, "markdown_url": markdown_url, "title": text.splitlines()[0][2:].strip(),
             "locale": "zh-cn" if urllib.parse.urlsplit(url).path.startswith("/zh-cn") else "en", "path": path,
             "source_path": path.replace("pages/", "source/", 1), "html_sha256": html_meta["sha256"],
             "html_response_url": html_meta["response_url"], **meta}
    links = {normalized(urllib.parse.urljoin(url, link)) for link in parser.links}
    return entry, text, {link for link in links if is_doc_page(link)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    root = args.output or Path(__file__).resolve().parents[1] / "docs" / "deepseek-api" / f"snapshot-{day}"
    root = root.resolve()
    if (root / "manifest.json").exists():
        raise SystemExit("Completed snapshot already exists. Choose a new --output directory.")
    root.mkdir(parents=True, exist_ok=True)
    previous = root / "manifest.incomplete.json"
    cached_assets = {}
    if previous.exists():
        cached_assets = {entry["url"]: entry for entry in json.loads(previous.read_text("utf-8"))["assets"]}
    started = datetime.now(timezone.utc).isoformat()
    seeds: set[str] = set()
    inventories = []
    for route in ("/robots.txt", "/sitemap.xml", "/zh-cn/sitemap.xml"):
        body, meta = fetch(HOST + route)
        inventory_path = "inventory/" + route.lstrip("/")
        write(root, inventory_path, body)
        item = {"url": HOST + route, "path": inventory_path, **meta}
        if route.endswith(".xml"):
            urls = [normalized(node.text) for node in ET.fromstring(body).findall(".//{*}loc")]
            seeds.update(urls)
            item["page_count"] = len(urls)
        inventories.append(item)
    entries = []
    contents = {}
    seen = set()
    pending = seeds
    failures = []
    while pending:
        batch = sorted(pending - seen)
        if not batch:
            break
        seen.update(batch)
        pending = set()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(archive_page, url): url for url in batch}
            for future in concurrent.futures.as_completed(futures):
                url = futures[future]
                try:
                    entry, content, linked = future.result()
                    write(root, entry["source_path"], content.encode("utf-8"))
                    entries.append(entry)
                    contents[url] = content
                    pending.update(linked - seen)
                except Exception as exc:
                    failures.append({"url": url, "error": str(exc)})
        print(f"Pages archived: {len(entries)}; next discovered: {len(pending)}; errors: {len(failures)}", flush=True)
    entries.sort(key=lambda entry: (entry["locale"], entry["url"]))
    # Match actual Markdown/HTML image references; code and example API URLs stay intact.
    image_pattern = re.compile(r'!\[[^\]]*\]\((https://[^\s)]+)\)|<img\b[^>]*?src=["\'](https://[^"\']+)["\']', re.I)
    image_urls = {match.group(1) or match.group(2) for text in contents.values() for match in image_pattern.finditer(text)}
    assets = []
    external_assets = []
    for url in sorted(image_urls):
        if not allowed_url(url):
            external_assets.append(url)
            continue
        try:
            cached = cached_assets.get(url)
            cached_path = (root / cached["path"]).resolve() if cached else None
            if cached_path and cached_path.is_relative_to(root) and cached_path.is_file() and hashlib.sha256(cached_path.read_bytes()).hexdigest() == cached["sha256"]:
                raw = cached_path.read_bytes()
                meta = {key: value for key, value in cached.items() if key not in ("url", "path")}
            else:
                raw, meta = fetch(url)
            if not meta["content_type"].startswith("image/"):
                raise ValueError(f"Not an image: {meta['content_type']}")
            # Content-addressing deduplicates identical English/Chinese images.
            suffix = Path(urllib.parse.urlsplit(url).path).suffix.lower()
            path = "assets/" + meta["sha256"] + suffix
            write(root, path, raw)
            assets.append({"url": url, "path": path, **meta})
        except Exception as exc:
            failures.append({"url": url, "error": str(exc)})
    lookup = {}
    for entry in entries:
        lookup[normalized(entry["url"])] = entry["path"]
        lookup[normalized(entry["markdown_url"])] = entry["path"]
    lookup.update({normalized(asset["url"]): asset["path"] for asset in assets})
    unresolved = set()

    def relative_url(url: str, page: str) -> str:
        key, fragment = urllib.parse.urldefrag(url)
        target = lookup.get(normalized(key))
        if target:
            return posixpath.relpath(target, posixpath.dirname(page)) + ("#" + fragment if fragment else "")
        if urllib.parse.urlsplit(url).netloc == "api-docs.deepseek.com":
            unresolved.add(url)
        return url

    md_link = re.compile(r'(\]\()(https://(?:api-docs|cdn)\.deepseek\.com/[^\s)]+)(\))')
    html_link = re.compile(r'((?:src|href)=["\'])(https://(?:api-docs|cdn)\.deepseek\.com/[^"\']+)(["\'])')
    autolink = re.compile(r'<(https://api-docs\.deepseek\.com/[^\s>]+)>')
    for entry in entries:
        text = contents[entry["url"]]
        for pattern in (md_link, html_link):
            text = pattern.sub(lambda match: match[1] + relative_url(match[2], entry["path"]) + match[3], text)
        text = autolink.sub(lambda match: "[文档](" + relative_url(match[1], entry["path"]) + ")" if normalized(urllib.parse.urldefrag(match[1])[0]) in lookup else match[0], text)
        source_relative = posixpath.relpath(entry["source_path"], posixpath.dirname(entry["path"]))
        header = f"> 官方来源：{entry['url']}  \n> 抓取时间：{entry['retrieved_at']}  \n> [未经改写的官方 Markdown]({source_relative})；本页仅将已归档链接改为本地链接。\n\n"
        rendered = (header + text).encode("utf-8")
        write(root, entry["path"], rendered)
        entry["local_sha256"] = hashlib.sha256(rendered).hexdigest()
    missing = sorted(seeds - {normalized(entry["url"]) for entry in entries})
    manifest = {"snapshot_date": day, "timezone": "Asia/Singapore", "started_at": started,
                "finished_at": datetime.now(timezone.utc).isoformat(), "host": HOST,
                "scope": "Both official sitemaps plus same-host documentation navigation; original Markdown and referenced official documentation/CDN images. External linked sites are excluded.",
                "sitemap_pages": len(seeds), "page_count": len(entries), "inventories": inventories,
                "pages": entries, "assets": assets, "external_image_references": external_assets,
                "unresolved_official_links": sorted(unresolved), "missing_sitemap_pages": missing, "failures": failures}
    # Do not mark an incomplete archive as a completed snapshot.
    incomplete = bool(failures or missing or unresolved)
    manifest_name = "manifest.incomplete.json" if incomplete else "manifest.json"
    lines = ["# DeepSeek 官方 API 文档快照", "", f"快照日期：{day}（Asia/Singapore）；共 {len(entries)} 页，中英文均保留。", "",
             "`pages/` 可离线沿相对链接阅读；`source/` 为官方原始 Markdown；`manifest.json` 记录来源、HTTP 元数据及 SHA-256。",
             "外部网站、控制台、第三方 SDK 文档、站点 UI 脚本不在归档范围；官方文档及其 CDN 图片已归档，第三方图片范围和任何未解析链接见清单。价格与服务能力是抓取时的快照，实施前需更新核对。", ""]
    for locale, label in (("zh-cn", "中文"), ("en", "English")):
        selected = [entry for entry in entries if entry["locale"] == locale]
        lines.extend([f"## {label}（{len(selected)} 页）", "", "| 文档 | 本地文件 | 官方来源 |", "| --- | --- | --- |"])
        for entry in selected:
            lines.append(f"| {entry['title'].replace('|', '/')} | [阅读]({entry['path']}) | [官网]({entry['url']}) |")
        lines.append("")
    write(root, "INDEX.md", ("\n".join(lines) + "\n").encode("utf-8"))
    if not incomplete:
        retained = {entry["path"] for entry in assets}
        for cached in cached_assets.values():
            old = (root / cached["path"]).resolve()
            if old.is_relative_to(root / "assets") and cached["path"] not in retained and old.is_file():
                old.unlink()
    # Publish the completion marker only after every output has been written.
    write(root, manifest_name, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    if not incomplete and previous.exists():
        previous.unlink()
    print(json.dumps({"output": str(root), "pages": len(entries), "sitemap_pages": len(seeds), "assets": len(assets), "missing": len(missing), "failures": failures, "unresolved_official_links": len(unresolved), "external_image_references": external_assets}, ensure_ascii=False), flush=True)
    if incomplete:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
