"""Verify documentation coverage, SHA-256 hashes and offline file links."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


def without_code(text: str) -> str:
    lines = []
    fence = ""
    fence_length = 0
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker[1]
            if not fence:
                fence, fence_length = token[0], len(token)
            elif token[0] == fence and len(token) >= fence_length:
                fence = ""
            continue
        if not fence:
            lines.append(line)
    return re.sub(r"(`+)([\s\S]*?)\1", "", "\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    root = args.snapshot.resolve()
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    errors = []
    verified = set()

    def check(relative, expected_hash):
        file = (root / relative).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            errors.append(f"Missing / unsafe file: {relative}")
            return
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected_hash:
            errors.append(f"SHA-256 mismatch: {relative}")
        verified.add(relative)

    for entry in manifest["inventories"] + manifest["assets"]:
        check(entry["path"], entry["sha256"])
    seeds = set()
    for entry in manifest["inventories"]:
        if entry["path"].endswith(".xml"):
            seeds.update(node.text.rstrip("/") for node in ET.fromstring((root / entry["path"]).read_bytes()).findall(".//{*}loc"))
    pages = manifest["pages"]
    urls = {entry["url"].rstrip("/") for entry in pages}
    if len(urls) != len(pages) or len(pages) != manifest["page_count"]:
        errors.append("Duplicate pages / incorrect page_count")
    if len(seeds) != manifest["sitemap_pages"] or seeds - urls:
        errors.append(f"Incomplete sitemap coverage: {sorted(seeds - urls)}")
    for field in ("failures", "missing_sitemap_pages", "unresolved_official_links"):
        if manifest[field]:
            errors.append(f"Nonempty {field}: {manifest[field]}")
    for entry in pages:
        check(entry["source_path"], entry["sha256"])
        check(entry["path"], entry["local_sha256"])
        if not (root / entry["source_path"]).read_text("utf-8").lstrip().startswith("# "):
            errors.append(f"Not an official Markdown document: {entry['source_path']}")
    link_pattern = re.compile(r'\]\(([^\s)]+)(?:\s+"[^"]*")?\)|(?:src|href)=["\']([^"\']+)["\']')
    links_checked = 0
    for relative in ["INDEX.md"] + [entry["path"] for entry in pages]:
        file = root / relative
        for match in link_pattern.finditer(without_code(file.read_text("utf-8"))):
            target = match[1] or match[2]
            parts = urllib.parse.urlsplit(target)
            if parts.scheme or parts.netloc or not parts.path:
                continue
            destination = (file.parent / urllib.parse.unquote(parts.path)).resolve()
            if not destination.is_relative_to(root) or not destination.is_file():
                errors.append(f"Broken local link: {relative} -> {target}")
            links_checked += 1
    result = {"snapshot": str(root), "sitemap_pages": len(seeds), "pages": len(pages),
              "locales": dict(Counter(entry["locale"] for entry in pages)),
              "asset_urls": len(manifest["assets"]), "unique_asset_files": len({entry["path"] for entry in manifest["assets"]}),
              "files_hash_checked": len(verified), "local_links_checked": links_checked,
              "external_image_references": manifest["external_image_references"], "errors": errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
