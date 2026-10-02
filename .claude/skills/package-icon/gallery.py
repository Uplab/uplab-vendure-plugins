#!/usr/bin/env python3
"""Builds the icon comparison page for the package-icon skill.

Usage: gallery.py <spec.json> <out.html>

spec.json:
{
  "package": "@uplab/vendure-plugin-<name>",
  "title": "Варіанти іконки",              # page heading
  "intro": "One or two sentences.",
  "sections": [
    {
      "heading": "Optional section heading",
      "options": [
        {"id": "1", "file": "option-1.svg", "name": "Short name",
         "idea": "Concept in one sentence.", "note": "How it reads at 32 px (optional)",
         "badge": "Recommended (optional)"}
      ]
    }
  ]
}
File paths are relative to the spec file. SVGs are inlined as data: URIs.
"""
import base64
import html
import json
import os
import sys

CSS = """
:root {
  --bg: #f3f4f7; --surface: #ffffff; --fg: #171a24; --muted: #5d6475; --line: #dde0e8;
  --accent: #255774; --badge-bg: #e7f1f7; --dark-ground: #0d1117; --light-ground: #ffffff;
  --display: "Manrope", "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12151c; --surface: #1a1e27; --fg: #e9ecf3; --muted: #9aa2b4; --line: #2a303d;
  --accent: #9ac8df; --badge-bg: #1e2f3d; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #12151c; --surface: #1a1e27; --fg: #e9ecf3; --muted: #9aa2b4; --line: #2a303d;
  --accent: #9ac8df; --badge-bg: #1e2f3d; color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font-family: var(--display); }
.wrap { max-width: 1180px; margin: 0 auto; padding-inline: 16px; padding-block: 32px 48px; display: grid; gap: 28px; }
header { display: grid; gap: 8px; max-width: 68ch; }
.pkg { font-family: var(--mono); font-size: 0.85rem; color: var(--muted); }
h1 { font-size: clamp(1.6rem, 3vw, 2.2rem); font-weight: 800; margin: 0; text-wrap: balance; }
header p { margin: 0; color: var(--muted); line-height: 1.55; }
section { display: grid; gap: 12px; }
section > h2 { font-size: 1.1rem; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: grid; gap: 14px; align-content: start; min-width: 0; }
.hero { display: grid; place-items: center; padding-block: 8px; }
.sizes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ground { border-radius: 10px; display: flex; align-items: center; justify-content: center; gap: 12px; padding-block: 12px; border: 1px solid var(--line); }
.ground.light { background: var(--light-ground); }
.ground.dark { background: var(--dark-ground); }
.meta { display: grid; gap: 6px; }
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.num { font-family: var(--mono); color: var(--muted); font-size: 0.9rem; }
.card h3 { font-size: 1.05rem; margin: 0; font-weight: 800; }
.badge { font-size: 0.72rem; font-weight: 600; color: var(--accent); background: var(--badge-bg); border-radius: 999px; padding: 2px 8px; }
.meta p { margin: 0; line-height: 1.5; font-size: 0.93rem; }
.meta .note { color: var(--muted); font-size: 0.85rem; }
"""


def data_uri(path):
    with open(path, "rb") as f:
        return "data:image/svg+xml;base64," + base64.b64encode(f.read()).decode()


def card(option, base):
    uri = data_uri(os.path.join(base, option["file"]))
    esc = lambda key: html.escape(option.get(key, ""))
    sizes = "".join(f'<img src="{uri}" alt="" width="{px}" height="{px}">' for px in (64, 32, 16))
    badge = f'<span class="badge">{esc("badge")}</span>' if option.get("badge") else ""
    note = f'<p class="note">32 px: {esc("note")}</p>' if option.get("note") else ""
    return f"""<article class="card" id="o{esc('id')}">
  <div class="hero"><img src="{uri}" alt="{esc('id')}: {esc('name')}" width="160" height="160"></div>
  <div class="sizes"><div class="ground light">{sizes}</div><div class="ground dark">{sizes}</div></div>
  <div class="meta"><div class="head"><span class="num">{esc('id')}</span><h3>{esc('name')}</h3>{badge}</div>
  <p>{esc('idea')}</p>{note}</div>
</article>"""


def main(spec_path, out_path):
    with open(spec_path) as f:
        spec = json.load(f)
    base = os.path.dirname(os.path.abspath(spec_path))
    sections = []
    for section in spec["sections"]:
        heading = f"<h2>{html.escape(section['heading'])}</h2>" if section.get("heading") else ""
        cards = "\n".join(card(o, base) for o in section["options"])
        sections.append(f'<section>{heading}<div class="grid">{cards}</div></section>')
    page = f"""<title>{html.escape(spec['package'].split('/')[-1].replace('vendure-plugin-', '').replace('-', ' ').title())} Icons</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=Manrope:wght@400;600;800&display=swap">
<style>{CSS}</style>
<div class="wrap">
  <header><span class="pkg">{html.escape(spec['package'])}</span><h1>{html.escape(spec['title'])}</h1><p>{html.escape(spec.get('intro', ''))}</p></header>
  {''.join(sections)}
</div>
"""
    with open(out_path, "w") as f:
        f.write(page)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
