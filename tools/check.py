#!/usr/bin/env python3
"""Self-check for the Road Track brand assets.

Fails if a colour pairing the theme relies on drops below WCAG AA, if an SVG
stops parsing, or if the generated raster set no longer matches what
manifest.json and LubeLogger's _Layout.cshtml ask for.

Run: python3 tools/check.py
"""
import json
import pathlib
import sys
import xml.etree.ElementTree as ET

BRAND = pathlib.Path(__file__).resolve().parent.parent / "brand"

ORANGE = "#FD8024"
ON_ORANGE = "#1A1A1A"
BS_DARK_BODY = "#212529"  # Bootstrap 5.3 --bs-body-bg in dark mode


def luminance(hex_colour):
    """WCAG 2.x relative luminance."""
    r, g, b = (int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5))
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(fg, bg):
    a, b = luminance(fg), luminance(bg)
    lo, hi = sorted((a, b))
    return (hi + 0.05) / (lo + 0.05)


def css_syntax_errors(text):
    """Comment-structure faults, which a browser recovers from SILENTLY.

    This exists because of an earlier release: adding `screen and` to the
    reports breakpoint left a stray `*/`, so the comment closed early and the
    whole @media block sat at top level as garbage. A browser drops that
    without a word — the page renders, just without the rules.

    DELIBERATELY NARROW, and narrowed on evidence. An earlier version of this
    also counted braces, which needs real CSS tokenization to do correctly:
    review found five separate ways to get it wrong (escapes in identifiers,
    unquoted `url()`, escaped `)` inside one, `url(` matched mid-identifier, and
    escaped spellings like `u\72l(`). Four invented failures on valid CSS, one
    hid a real fault. Each fix was small and the next case was always one step
    further out. Brace counting is gone: an unclosed brace breaks a whole file
    visibly, while a stray `*/` is the one that hides.

    Deliberately simple: strings and escapes are skipped because `content: "/*"`
    is legal and common; nothing else is modelled. KNOWN LIMIT — an UNQUOTED
    `url(a/*b.png)` would read as a comment opening. No stylesheet here uses
    `url()` at all; if one starts to, quote it or revisit this with tinycss2.
    """
    errors = []
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end == -1:
                errors.append(f"line {line}: unterminated /* — the rest of the "
                              f"file is swallowed by the comment")
                break
            line += text.count("\n", i, end)
            i = end + 2
        elif text.startswith("*/", i):
            errors.append(f"line {line}: stray */ outside a comment — a comment "
                          f"was closed twice, so what follows is parsed as CSS "
                          f"and the next rule is dropped")
            i += 2
        elif c == "\\" and i + 1 < n:
            i += 2                      # an escape cannot open or close a comment
        elif c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            line += text.count("\n", i, min(j, n))
            i = j + 1
        else:
            i += 1
    return errors


def main():
    failures = []

    # ── Colour pairings the theme asserts in its comments ──────────────
    # (foreground, background, minimum, what it is)
    pairings = [
        ("#A64E0B", "#FFFFFF", 4.5, "light-mode link on white"),
        (ORANGE, BS_DARK_BODY, 4.5, "dark-mode link on dark body"),
        (ON_ORANGE, ORANGE, 4.5, "button label on brand orange"),
        ("#8A4109", "#FFEEE1", 4.5, "accordion active, light"),
        ("#FEB784", "#3A1D08", 4.5, "accordion active, dark"),
        ("#2D2D2D", ORANGE, 3.0, "road on the brand tile"),
    ]
    for fg, bg, floor, label in pairings:
        ratio = contrast(fg, bg)
        status = "ok " if ratio >= floor else "FAIL"
        print(f"  [{status}] {ratio:5.2f}:1 (min {floor})  {label}  {fg} on {bg}")
        if ratio < floor:
            failures.append(f"{label}: {ratio:.2f}:1 < {floor}")

    # The theme picks dark text on orange buttons rather than white. That is
    # only defensible while dark actually wins, so assert it rather than
    # trusting the comment.
    if contrast(ON_ORANGE, ORANGE) <= contrast("#FFFFFF", ORANGE):
        failures.append("white beats #1A1A1A on the brand orange — flip the button label colour")

    # ── SVGs still parse, and the wordmark cannot clip ─────────────────
    for name in ("icon.svg", "icon-maskable.svg", "logo.svg"):
        path = BRAND / name
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            failures.append(f"{name}: {exc}")
            continue
        print(f"  [ok ] {name} parses, viewBox={root.get('viewBox')}")

    logo = ET.parse(BRAND / "logo.svg").getroot()
    text = logo.find("{http://www.w3.org/2000/svg}text")
    # LubeLogger renders the logo in a 204x48 box (site.css .lubelogger-logo),
    # so the wordmark's pinned width plus its x offset must stay inside it.
    span = float(text.get("x")) + float(text.get("textLength"))
    print(f"  [{'ok ' if span <= 204 else 'FAIL'}] wordmark ends at {span:g}px of 204")
    if span > 204:
        failures.append(f"wordmark overruns the 204px logo box ({span:g}px)")

    # ── Rasters match what the app actually requests ───────────────────
    # _Layout.cshtml hardcodes these three; manifest.json declares the rest.
    required = {"icon-128.png", "icon-192.png", "launch.png", "favicon.ico"}
    manifest = json.loads((BRAND / "manifest.json").read_text())
    required |= {pathlib.PurePosixPath(i["src"]).name for i in manifest["icons"]}
    missing = sorted(n for n in required if not (BRAND / n).exists())
    print(f"  [{'ok ' if not missing else 'FAIL'}] {len(required)} referenced raster(s) present")
    if missing:
        failures.append(f"missing rasters: {', '.join(missing)}")

    if manifest["name"] != "Road Track":
        failures.append(f'manifest name is {manifest["name"]!r}, expected "Road Track"')

    # ── The scanner itself ────────────────────────────────────────────
    # Every case below is one a review caught it getting wrong, or one it must
    # keep catching. It lives here rather than in a scratch script because both
    # false positives in its first version were found in review, not by a test,
    # and a false positive fails CI on valid CSS — worse than the gap this check
    # closes.
    must_pass = (
        '.a::after { content: "*/"; }',                  # comment glyphs in strings
        '.a::after { content: "/*"; }',
        r'.a::before { content: "he said \" ok"; }',
        '/* { } { */ .d { color: red; }',                # braces inside a comment
        '@media print { .c { color: red } }',
        # Every construct a review found the brace-counting version getting
        # wrong. They are kept as cases, not because this version could fail
        # them, but so that anyone who reintroduces brace tracking has to make
        # them pass first.
        r'.foo\{bar { color: red; }',
        r'.foo\}bar { color: red; }',
        '.foo\\7B bar { color: red; }',
        '.a { background: url(a}b.png); }',
        r'.a { background: url(a\)b{c.png); }',
        '.a { background: u\\72l(a}b.png); }',
        '.a { background: myurl(} ); }',
        '.a { background: url(data:image/svg+xml,<svg><style>.x{fill:red}</style></svg>); }',
    )
    must_fail = (
        '.a { color: red; }\n */\n.b { color: blue; }',  # the stray */ above
        '.a { color: red; }\n/* never closed\n',
    )
    wrong = ([f"false positive: {c!r} -> {css_syntax_errors(c)[0]}"
              for c in must_pass if css_syntax_errors(c)]
             + [f"missed: {c!r}" for c in must_fail if not css_syntax_errors(c)])
    failures.extend(wrong)
    print(f"  [{'ok ' if not wrong else 'FAIL'}] css scanner: "
          f"{len(must_pass)} valid clean, {len(must_fail)} faults caught")

    # ── Stylesheets actually parse ────────────────────────────────────
    # Every .css that ships in the image, not a hand-kept list: the one that
    # breaks will be the one somebody forgot to add.
    sheets = sorted(BRAND.rglob("*.css"))
    bad = 0
    for sheet in sheets:
        for err in css_syntax_errors(sheet.read_text()):
            failures.append(f"{sheet.relative_to(BRAND.parent)}: {err}")
            bad += 1
    print(f"  [{'ok ' if not bad else 'FAIL'}] {len(sheets)} stylesheet(s) parse")

    # ── Installability ────────────────────────────────────────────────
    # Chromium will not offer to install the app unless the manifest declares
    # BOTH a 192px and a 512px icon. Shipped without the 512 for most of its
    # early history — every other icon was present, the manifest was internally
    # consistent, and the check above passed happily, because "every icon the
    # manifest names exists" cannot notice an icon the manifest never names.
    #
    # The size is read out of the PNG header rather than trusted from the
    # `sizes` string: these are committed build output, so a declaration and
    # its file can drift, and a 512x512 that is really 192px fails the same
    # way with none of the symptoms.
    def png_size(path):
        with open(path, "rb") as fh:
            head = fh.read(24)
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")

    for need in (192, 512):
        declared = [i for i in manifest["icons"]
                    if i["sizes"] == f"{need}x{need}" and i.get("purpose", "any") == "any"]
        if not declared:
            failures.append(f"manifest declares no {need}x{need} purpose=any icon "
                            f"— Chromium will not offer to install the app")
            continue
        for icon in declared:
            name = pathlib.PurePosixPath(icon["src"]).name
            actual = png_size(BRAND / name) if (BRAND / name).exists() else None
            if actual != (need, need):
                failures.append(f"{name} is declared {need}x{need} but is {actual}")
    print(f"  [{'ok ' if not failures else 'FAIL'}] manifest declares 192 and 512 "
          f"icons at their stated sizes")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll brand checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
