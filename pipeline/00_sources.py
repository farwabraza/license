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

from common import DATA, canonical_section, save_json

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
#
# pypdf does not emit a page in reading order. On most pages the block header ("Ciclomotori Blocco: 11023")
# comes before its questions, but on about a quarter of them it comes AFTER them, long titles wrap so that
# "Blocco: 13010" sits alone on its line, and a block that runs over a page repeats its header at the bottom
# of the continuation page. So the listato is parsed one page at a time: statements are grouped by their
# "DOMANDE VERE" heading and matched to the page's headers by order, wherever the headers were printed.

MARGIN_LABELS = {"I VEICOLI", "LA STRADA", "SEGNALETICA STRADALE", "EQUIPAGGIAMENTO DEI VEICOLI", "NORME DI COMPORTAMENTO",
                 "DOCUMENTI", "INCIDENTI E ASSICURAZIONE", "PRIMO SOCCORSO", "SICUREZZA E INQUINAMENTO", "IL VEICOLO A MOTORE"}
BULLETS = "•·●▪\ufffd"          # \ufffd: a bullet pypdf could not decode
RE_BLOCK = re.compile(r"^(?P<title>.*?)\s*Blocco:\s*(?P<id>\d{4,6})\s*$")
RE_Q = re.compile(rf"^(?P<n>\d(?: ?\d)?)\s*[{BULLETS}]\s*(?P<text>.*)$")      # "1 1 •" is 11 on one page
RE_BULLET_ONLY = re.compile(rf"^[{BULLETS}]\s*(?P<text>.*)$")
RE_FIG = re.compile(r"^(Figura\s+\d+(?:/\d+)*\s*)+$")
RE_PAGE = re.compile(r"^\d{1,3}$")
RE_POL = re.compile(r"^DOMANDE\s+(VERE|FALSE)$")


def pdf_pages(path: Path) -> list[str]:
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit("pip install pypdf  (it is in requirements.txt)")
    reader = PdfReader(str(path))
    return [(page.extract_text() or "") for page in reader.pages]


def _clean(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def _page_events(lines):
    """One page's lines → a list of (kind, value) events, page furniture removed."""
    lines = [_clean(x) for x in lines]
    lines = [x for x in lines if x]
    ev, i = [], 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if re.fullmatch(r"\d{1,2}", line) and i < len(lines) and RE_BULLET_ONLY.match(lines[i]):
            line = f"{line} • {RE_BULLET_ONLY.match(lines[i]).group('text')}"     # number and bullet on separate lines
            i += 1
        if line.endswith("Figura") and line.startswith("Figura") and i < len(lines) and re.fullmatch(r"[\d/ ]+", lines[i]):
            line = f"{line} {lines[i]}"                     # "Figura 127 Figura" / "927/929/967"
            i += 1
        if line in MARGIN_LABELS or RE_PAGE.fullmatch(line):
            continue
        m = RE_BLOCK.match(line)
        if m:
            title = m.group("title").strip()
            if not title:                                   # wrapped title: its lines were read as statement text
                parts = []
                while ev and ev[-1][0] == "cont" and len(parts) < 2:
                    parts.insert(0, ev.pop()[1])
                title = " ".join(parts)
            ev.append(("header", {"id": m.group("id"), "title": _clean(title)}))
        elif RE_FIG.match(line):
            ev.append(("fig", [int(x) for x in re.findall(r"\d+", line)]))
        elif RE_POL.match(line):
            ev.append(("pol", RE_POL.match(line).group(1) == "VERE"))
        elif line.isupper() and canonical_section(line):     # running head (fuzzy: the PDF spells some two ways)
            ev.append(("section", canonical_section(line)))
        elif RE_Q.match(line):
            qm = RE_Q.match(line)
            ev.append(("q", {"n": int(qm.group("n").replace(" ", "")), "text": qm.group("text")}))
        else:
            ev.append(("cont", line))                        # wrapped piece of the previous statement
    return ev


def parse_listato(pages):
    """pages: list of page texts → (sections in order, blocks, warnings)."""
    sections, blocks, warnings, by_id = [], [], [], {}
    current, polarity, section, started = None, None, None, False

    def new_block(h, page_no):
        if h["id"] not in by_id:                             # a block printed twice keeps collecting into the first
            by_id[h["id"]] = {"section": section, "title": h["title"], "block": h["id"], "page": page_no,
                              "figures": [], "questions": []}
            blocks.append(by_id[h["id"]])
        return by_id[h["id"]]

    for page_no, text in enumerate(pages, start=1):
        ev = _page_events(text.splitlines())
        headers = [v for k, v in ev if k == "header"]
        if not started:
            if not headers:
                continue                                     # cover + index
            started = True
        for k, v in ev:
            if k == "section":
                section = v
                if v not in sections:
                    sections.append(v)
        figs = []
        for k, v in ev:
            if k == "fig":
                figs += [f for f in v if f not in figs]

        # headers that start a new block (a repeat of the block being continued, printed at the page foot, is not new)
        fresh = []
        for h in headers:
            if (current is None or h["id"] != current["block"]) and all(h["id"] != x["id"] for x in fresh):
                fresh.append(h)

        # the page's statements: a leading run continuing the previous block, then one run per block started here.
        # A block starts at "DOMANDE VERE"; at a second "DOMANDE FALSE" (some blocks have only false statements);
        # or where numbering drops back to 1 inside a false list (the VERE label is missing from a few pages' text).
        prev = current["questions"] if current else []
        runs = [{"pol": polarity, "items": []}]
        pol, has_false, last_n = polarity, any(not q["answer"] for q in prev), (prev[-1]["n"] if prev else 0)
        for k, v in ev:
            if k == "pol":
                if v or has_false:
                    runs.append({"pol": v, "items": []})
                else:
                    runs[-1]["items"].append((k, v))
                pol, has_false, last_n = v, not v, 0
            elif k == "q":
                if pol is False and v["n"] == 1 and last_n > 1:
                    runs.append({"pol": True, "items": []})
                    pol, has_false = True, False
                runs[-1]["items"].append((k, v))
                last_n = v["n"]
            elif k == "cont":
                runs[-1]["items"].append((k, v))
        groups = runs[1:]
        if len(groups) != len(fresh):
            warnings.append(f"page {page_no}: {len(fresh)} new block headers but {len(groups)} 'DOMANDE VERE' groups")

        targets, block = [current], current
        for gi in range(len(groups)):
            if gi < len(fresh):
                block = new_block(fresh[gi], page_no)
            targets.append(block)                            # more groups than headers: stay on the previous block
        page_blocks = targets[1:]
        for h in fresh[len(groups):]:                        # header here, its questions start on the next page
            block = new_block(h, page_no)
            page_blocks.append(block)
        for b in page_blocks:
            if b is not None:
                b["figures"] += [f for f in figs if f not in b["figures"]]

        for run, b in zip(runs, targets):
            pol, last = run["pol"], None
            for k, v in run["items"]:
                if k == "pol":
                    pol = False
                elif k == "q":
                    last = None
                    if b is not None and pol is not None:
                        last = {"n": v["n"], "answer": pol, "text": v["text"]}
                        b["questions"].append(last)
                elif last is not None:                       # continuation line
                    if last["text"].endswith("-") and v[:1].isalpha():
                        last["text"] = last["text"][:-1] + v    # hyphenated at the line break: per- / sone → persone
                    else:
                        last["text"] += " " + v
            polarity = pol
        current = block

    for b in blocks:
        for q in b["questions"]:
            q["text"] = _clean(q["text"])
    return sections, [b for b in blocks if b["questions"]], warnings


def report(blocks, warnings=()):
    per = {}
    for b in blocks:
        d = per.setdefault(b["section"], {"blocks": 0, "questions": 0})
        d["blocks"] += 1
        d["questions"] += len(b["questions"])
    total = sum(d["questions"] for d in per.values())
    print(f"\nListato: {len(per)} sections, {len(blocks)} blocks, {total} questions")
    for s, d in per.items():
        print(f"  {d['blocks']:3d} blocks {d['questions']:4d} q  {s}")
    gaps = []                                   # statements are numbered consecutively under each VERE / FALSE heading
    for b in blocks:
        for pol in (True, False):
            ns = [q["n"] for q in b["questions"] if q["answer"] is pol]
            if ns and ns != list(range(ns[0], ns[0] + len(ns))):    # a couple of blocks start at 2 or 5 in the PDF itself
                gaps.append(b["block"])
                break
    if gaps:
        print(f"  ⚠ {len(gaps)} blocks whose statement numbers skip or repeat (parse problem?): {gaps[:10]}")
    for w in list(warnings)[:10]:
        print(f"  ⚠ {w}")
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
        named = [p for p in pdfs if "listato" in p.name.lower()]
        pdf = (named or pdfs)[0]
        others = [p.name for p in pdfs if p != pdf]
        if others:
            print(f"Using {pdf.name} as the listato; ignoring other PDFs: {others}")
        pages = pdf_pages(pdf)
        text = "\n".join(pages)
        if "--dump" in sys.argv:
            (DATA / "listato_raw.txt").write_text(text, encoding="utf-8")
            print(f"Wrote {DATA / 'listato_raw.txt'}")
        m = re.search(r"aggiornata al (\d{2}/\d{2}/\d{4})", text)
        sections, blocks, warnings = parse_listato(pages)
        report(blocks, warnings)
        save_json(LISTATO_OUT, {"source": pdf.name, "updated": m.group(1) if m else None, "sections": sections, "blocks": blocks})
        print(f"Wrote {LISTATO_OUT} (listato dated {m.group(1) if m else 'unknown'})")


if __name__ == "__main__":
    main()
