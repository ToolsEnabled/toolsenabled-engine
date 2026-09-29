"""Small dependency-local PDF fallback for the master report.

The normal path is browser print-to-PDF.  Some locked-down Windows desktops
have a headless Chromium build that never completes a file:// print job.  This
fallback keeps the report hard-copyable without downloading a renderer: it
extracts the already-reviewed HTML text and writes a paginated PDF with the
installed PyMuPDF package.
"""
from __future__ import annotations

import re
import sys
import textwrap
from html.parser import HTMLParser
from pathlib import Path

import fitz


class ReportText(HTMLParser):
    BLOCKS = {
        "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
        "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
        "h3", "h4", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
        "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"script", "style", "noscript"}:
            self.skip += 1
        if self.skip == 0 and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip and tag in {"script", "style", "noscript"}:
            self.skip -= 1
        if self.skip == 0 and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip == 0:
            self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\u00a0", " ")
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r"\n[ \t]+", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-master-report-fallback.py INPUT.html OUTPUT.pdf")
    html_path = Path(sys.argv[1]).resolve()
    pdf_path = Path(sys.argv[2]).resolve()
    parser = ReportText()
    parser.feed(html_path.read_text(encoding="utf-8"))
    lines: list[str] = []
    for paragraph in parser.text().splitlines():
        paragraph = paragraph.strip()
        if not paragraph:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        lines.extend(textwrap.wrap(paragraph, width=104, break_long_words=False, break_on_hyphens=False) or [""])
    while lines and lines[-1] == "":
        lines.pop()

    doc = fitz.open()
    page_width, page_height = 612, 792
    margin_x, top_y, bottom_y = 42, 44, 44
    font_size, line_height = 8.6, 12.0
    page = doc.new_page(width=page_width, height=page_height)
    y = top_y
    page_number = 1
    for line in lines:
        if y + line_height > page_height - bottom_y:
            page.insert_text((margin_x, page_height - 22), f"Master Work Report - page {page_number}", fontsize=7, fontname="helv", color=(0.32, 0.39, 0.49))
            page_number += 1
            page = doc.new_page(width=page_width, height=page_height)
            y = top_y
        if line:
            page.insert_text((margin_x, y), line, fontsize=font_size, fontname="helv", color=(0.09, 0.13, 0.20))
        y += line_height
    page.insert_text((margin_x, page_height - 22), f"Master Work Report - page {page_number}", fontsize=7, fontname="helv", color=(0.32, 0.39, 0.49))
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(pdf_path), garbage=4, deflate=True)
    doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
