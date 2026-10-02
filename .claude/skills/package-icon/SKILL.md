---
name: package-icon
description: Design the icon for a plugin package — a collection of concepts to choose from, then the chosen one in Uplab colourways (use when a package needs an icon or asks for icon options).
---

Every publishable package has `packages/vendure-plugin-<name>/assets/icon.svg`, shown at the top
of its README. All icons follow the same rules and the same flow.

## Rules

- Hand-written SVG: `viewBox="0 0 512 512"`, `width`/`height` 512, `role="img"`,
  `aria-label="<package concept>"`.
- Background: `<rect width="512" height="512" rx="112" fill="…"/>` — the same rounded square on
  every package.
- Flat shapes, 2–3 colours, no gradients, filters, text or external fonts. A short glyph like `/` is
  fine. Never a third-party logo, a flag, or the Vendure mark.
- Must read at 16 and 32 px (npm, GitHub) and at 96 px (README header): bold geometry, strokes
  ≥ 20 at 512, nothing thinner than ~24 px of fill.
- Final colours come from the Uplab palette below. Concepts may use any colours; colour is fixed in
  step 4.

### Uplab palette

The uplab.io site palette (its `bluemine` blue scale plus the CTA amber and the page canvas).

| Token       | Hex       | Use                              |
| ----------- | --------- | -------------------------------- |
| brand       | `#255774` | default background, primary mark |
| brand-950   | `#172c3a` | dark background, dark marks      |
| brand-600   | `#307499` | secondary shapes on dark         |
| brand-500   | `#4191b6` | secondary shapes                 |
| brand-400   | `#65abcb` | secondary shapes, lighter        |
| brand-200   | `#cae1ed` | secondary shapes on light        |
| amber (CTA) | `#f4b952` | accent                           |
| warm white  | `#f5f3f5` | light background, light marks    |

Chosen so far:

- `unified-slug` — brand background, brand-500/400 secondary, warm-white mark with a brand slash.
- `turbosms` predates these rules and uses TurboSMS's own navy and yellow; recolour it the next time
  it is touched.

## Flow

1. **Concepts.** Spawn a designer subagent (`Agent`, `model: "fable"`) with the package's purpose
   (read its README) and the rules above. Ask for **8 genuinely different concepts** as
   `option-1.svg … option-8.svg` in the scratchpad (`<scratchpad>/icons-<name>/`), each rendered to
   PNG at 512, 96 and 32 px (`qlmanage -t -s <px> -o <dir> <file.svg>`) and checked by the agent
   itself, iterating on anything muddy or off-centre at 32 px. Report per option: name (2–4 words),
   concept in one sentence, palette, how it reads at 32 px, plus top 2 recommendations.
2. **Gallery.** Build the comparison page with
   `python3 .claude/skills/package-icon/gallery.py <spec.json> <out.html>` (spec format in the
   script's docstring) and publish it with the `Artifact` tool. Each option is shown large and at
   64/32/16 px on light and dark grounds. Give the user a short table and the recommendation; ask
   for a number.
3. **User picks** a concept (they may also ask for shape tweaks — apply them, re-render, republish
   the same file so the URL stays).
4. **Colourways.** Recolour the chosen concept in **4 Uplab colourways** (e.g. brand + amber,
   brand-950 + amber, brand + warm white, warm-white background + brand). Render them, check them
   at 32 px, add them to the top of the same gallery page and republish. Ask for a letter.
5. **Ship.** Copy the chosen SVG to `packages/vendure-plugin-<name>/assets/icon.svg` (not in the
   package `files` — the README links it by absolute
   `https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-<name>/assets/icon.svg`,
   96×96, centred above the title like the other packages). Commit as
   `docs(<name>): add the package icon`. No changeset — the icon is not published to npm.
   Add the chosen colours to "Chosen so far" above, so the family stays consistent.
