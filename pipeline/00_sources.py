"""Step 00 — turn your source material into data the pipeline can use.

Put the files in data/sources/:
  - any number of .epub manuals            → data/manual_sections.json  (used by 02_enrich.py as ground truth)
  - ListatoAB.pdf from neca.it (optional)  → data/listato.json          (used by 01_fetch_bank.py as the question bank)

Run:  python pipeline/00_sources.py
      python pipeline/00_sources.py --dump      # also writes data/listato_raw.txt so you can inspect the PDF text
Safe to re-run.
"""
import html
import json
import re
import sys
import unicodedata
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

from common import DATA, save_json

SOURCES = DATA / "sources"
SOURCES.mkdir(parents=True, exist_ok=True)
MANUAL_OUT = DATA / "manual_sections.json"
LISTATO_OUT = DATA / "listato.json"

# ---------------------------------------------------------------- EPUB manuals

class _SectionParser(HTMLParser):
    BLOCK = {"p", "li", "div", "td", "th", "blockquote", "dd", "dt", "figcaption", "br", "tr"}
    HEAD = {"h1", "h2", "h3", "h4"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections = []
        self.title = None
        self.buf = []
        self.in_head = None
        self.skip = 0

    def _flush(self):
        text = re.sub(r"[ \t]+", " ", "\n".join(self.buf)).strip()
        text = re.sub(r"\n{2,}", "\n", text)
        if self.title is not None or text:
            self.sections.append({"title": (self.title or "").strip(), "text": text})
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in self.HEAD:
            self._flush()
            self.in_head = tag
            self.title = ""
        elif tag in self.BLOCK:
            self.buf.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
        elif tag in self.HEAD:
            self.in_head = None
        elif tag in self.BLOCK:
            self.buf.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        if self.in_head is not None:
            self.title += data
        else:
            self.buf.append(data)

    def close(self):
        super().close()
        self._flush()


def epub_documents(path: Path):
    """Yield (name, html) for each document in spine order."""
    with zipfile.ZipFile(path) as z:
        try:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
            opf_path = container.find(".//c:rootfile", ns).attrib["full-path"]
            opf = ET.fromstring(z.read(opf_path))
            base = str(Path(opf_path).parent)
            ns_opf = {"o": "http://www.idpf.org/2007/opf"}
            manifest = {i.attrib["id"]: i.attrib["href"] for i in opf.findall(".//o:manifest/o:item", ns_opf)}
            order = [manifest[r.attrib["idref"]] for r in opf.findall(".//o:spine/o:itemref", ns_opf) if r.attrib["idref"] in manifest]
            names = [(f"{base}/{h}" if base not in ("", ".") else h) for h in order]
        except Exception:  # noqa: BLE001 — fall back to any html in the zip
            names = sorted(n for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm")))
        for n in names:
            n = n.split("#")[0]
            if n in z.namelist():
                yield n, z.read(n).decode("utf-8", "ignore")


def extract_manual(path: Path):
    sections = []
    for name, doc in epub_documents(path):
        p = _SectionParser()
        p.feed(doc)
        p.close()
        for s in p.sections:
            s["text"] = html.unescape(s["text"])
            words = len(s["text"].split())
            if words >= 25:
                sections.append({"book": path.stem[:40], "title": s["title"][:160], "text": s["text"], "words": words})
    return sections


# ---------------------------------------------------------------- Neca listato PDF

MARGIN_LABELS = {"I VEICOLI", "LA STRADA", "SEGNALETICA STRADALE", "EQUIPAGGIAMENTO DEI VEICOLI", "NORME DI COMPORTAMENTO",
                 "DOCUMENTI", "INCIDENTI E ASSICURAZIONE", "PRIMO SOCCORSO", "SICUREZZA E INQUINAMENTO", "IL VEICOLO A MOTORE"}
RE_BLOCK = re.compile(r"^(?P<title>.+?)\s+Blocco:\s*(?P<id>\d{4,6})\s*$")
RE_Q = re.compile(r"^(?P<n>\d{1,2})\s*[•·]\s*(?P<text>.*)$")
RE_FIG = re.compile(r"^(Figura\s+\d+\s*)+$")
RE_PAGE = re.compile(r"^\d{1,3}$")
RE_POL = re.compile(r"^\s*DOMANDE\s+(VERE|FALSE)\s*$")


def pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit("pip install pypdf  (it is in requirements.txt)")
    reader = PdfReader(str(path))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def parse_listato(text: str):
    sections, current_section, block, polarity, q = [], None, None, None, None
    blocks = []

    def close_q():
        nonlocal q
        if q is not None:
            q["text"] = re.sub(r"\s+", " ", q["text"]).strip()
            if q["text"]:
                block["questions"].append(q)
        q = None

    def close_block():
        nonlocal block
        close_q()
        if block is not None and block["questions"]:
            blocks.append(block)
        block = None

    started, last_upper, page_blocks, page = False, None, [], 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if not started:
            if RE_BLOCK.match(line):
                started = True
                current_section = last_upper
                if current_section:
                    sections.append(current_section)
            else:
                if line.isupper() and len(line) > 3 and line not in MARGIN_LABELS:
                    last_upper = line
                continue                                  # skip cover + index
        if line in MARGIN_LABELS:
            continue
        if RE_PAGE.match(line):
            page_blocks = []                              # figures listed on a page belong to that page's blocks
            page += 1
            continue
        m = RE_BLOCK.match(line)
        if m:
            close_block()
            block = {"section": current_section, "title": m.group("title").strip(), "block": m.group("id"),
                     "page": page, "figures": [], "questions": []}
            page_blocks.append(block)
            polarity = None
            continue
        if RE_FIG.match(line):
            figs = [int(x) for x in re.findall(r"\d+", line)]
            for b in page_blocks:
                b["figures"] += [f for f in figs if f not in b["figures"]]
            close_q()
            continue
        pm = RE_POL.match(line)
        if pm:
            close_q()
            polarity = pm.group(1) == "VERE"
            continue
        if line.isupper() and len(line) > 3 and not RE_Q.match(line):
            close_block()
            current_section = line
            if current_section not in sections:
                sections.append(current_section)
            continue
        qm = RE_Q.match(line)
        if qm and block is not None and polarity is not None:
            close_q()
            q = {"n": int(qm.group("n")), "answer": polarity, "text": qm.group("text")}
            continue
        if q is not None:                                  # wrapped continuation line
            q["text"] += " " + line
    close_block()
    return sections, blocks


def report(blocks):
    per = {}
    for b in blocks:
        d = per.setdefault(b["section"], {"blocks": 0, "questions": 0})
        d["blocks"] += 1
        d["questions"] += len(b["questions"])
    total = sum(d["questions"] for d in per.values())
    print(f"\nListato: {len(blocks)} blocks, {total} questions")
    for s, d in per.items():
        print(f"  {d['blocks']:3d} blocks {d['questions']:4d} q  {s}")
    small = [b["block"] for b in blocks if len(b["questions"]) < 3]
    if small:
        print(f"  ⚠ {len(small)} blocks with fewer than 3 questions (parse problem?): {small[:10]}")
    if total < 6000:
        print("  ⚠ Expected roughly 7,000 questions. Run with --dump and check data/listato_raw.txt.")


def main():
    epubs = sorted(SOURCES.glob("*.epub"))
    pdfs = sorted(SOURCES.glob("*.pdf"))
    if not epubs and not pdfs:
        print(f"Nothing in {SOURCES}. Put your .epub manuals and ListatoAB.pdf there.")
        return

    if epubs:
        all_sections = []
        for p in epubs:
            secs = extract_manual(p)
            print(f"{p.name[:60]}: {len(secs)} sections, {sum(s['words'] for s in secs):,} words")
            all_sections += secs
        save_json(MANUAL_OUT, all_sections)
        print(f"Wrote {MANUAL_OUT}")

    if pdfs:
        pdf = pdfs[0]
        text = pdf_text(pdf)
        if "--dump" in sys.argv:
            (DATA / "listato_raw.txt").write_text(text, encoding="utf-8")
            print(f"Wrote {DATA / 'listato_raw.txt'}")
        m = re.search(r"aggiornata al (\d{2}/\d{2}/\d{4})", text)
        sections, blocks = parse_listato(text)
        report(blocks)
        save_json(LISTATO_OUT, {"source": pdf.name, "updated": m.group(1) if m else None, "sections": sections, "blocks": blocks})
        print(f"Wrote {LISTATO_OUT} (listato dated {m.group(1) if m else 'unknown'})")


if __name__ == "__main__":
    main()
