#!/usr/bin/env python3
"""Render reports/TOOLSENABLED-SUGGESTIONS.md to the owner's Desktop as
'ToolsEnabled Suggestions.pdf' (R55: the living suggestions report).

The markdown file is the agent-editable source of truth (Sol/Fable/Opus-class
authors only, per owner order); this renderer is how every edit becomes the
Desktop PDF the owner actually reads. Deliberately dependency-light: python-docx
builds an intermediate docx, Word COM exports the PDF. Run after every edit:

    python tools/render-suggestions-pdf.py
"""
import re
import sys
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'reports', 'TOOLSENABLED-SUGGESTIONS.md')
# The owner's Desktop, not the builder's -- expanduser('~') resolves to
# whichever account actually runs this script (via USERPROFILE on Windows),
# so the PDF lands in front of whoever that is on whatever machine this runs.
DESKTOP_PDF = os.path.join(os.path.expanduser('~'), 'Desktop', 'ToolsEnabled Suggestions.pdf')

STATUS_ORDER = ['approved', 'dispatched', 'proposed', 'shipped', 'rejected']


def build_docx(md_text, docx_path):
    import docx
    from docx.shared import Pt

    doc = docx.Document()
    doc.core_properties.author = 'ToolsEnabled'
    doc.core_properties.last_modified_by = 'ToolsEnabled'
    style = doc.styles['Normal']
    style.font.name = 'Calibri'
    style.font.size = Pt(11)

    in_code = False
    for raw in md_text.splitlines():
        line = raw.rstrip()
        if line.startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            p = doc.add_paragraph(line)
            p.style = doc.styles['No Spacing']
            for run in p.runs:
                run.font.name = 'Consolas'
                run.font.size = Pt(9)
            continue
        if line.startswith('# '):
            doc.add_heading(line[2:], level=0)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=1)
        elif line.startswith('- '):
            text = re.sub(r'\*\*(.+?)\*\*', r'\1', line[2:])
            doc.add_paragraph(text, style='List Bullet')
        elif line.strip() == '---':
            doc.add_paragraph()
        elif line.strip():
            text = re.sub(r'\*\*(.+?)\*\*', r'\1', line)
            text = re.sub(r'\*(.+?)\*', r'\1', text)
            doc.add_paragraph(text)
    doc.save(docx_path)


def docx_to_pdf(docx_path, pdf_path):
    script = (
        "$word = New-Object -ComObject Word.Application; $word.Visible = $false; "
        f"$doc = $word.Documents.Open('{docx_path}', $false, $true); "
        f"$doc.SaveAs([ref]'{pdf_path}', [ref]17); $doc.Close($false); $word.Quit(); "
        "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null"
    )
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-Command', script],
        capture_output=True, text=True, timeout=180,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    )
    if result.returncode != 0:
        raise RuntimeError(f'Word export failed: {result.stderr[:500]}')


def main():
    with open(SOURCE, encoding='utf-8') as fh:
        md_text = fh.read()
    statuses = re.findall(r'^- Status: *(\w+)', md_text, re.M)
    counts = {s: statuses.count(s) for s in STATUS_ORDER if statuses.count(s)}
    with tempfile.TemporaryDirectory() as tmp:
        docx_path = os.path.join(tmp, 'suggestions.docx')
        build_docx(md_text, docx_path)
        docx_to_pdf(docx_path, DESKTOP_PDF)
    size = os.path.getsize(DESKTOP_PDF)
    print(f'rendered {DESKTOP_PDF} ({size} bytes); entries by status: {counts}')


if __name__ == '__main__':
    main()
