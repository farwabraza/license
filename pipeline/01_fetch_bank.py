"""Step 01 — build data/bank.json.

Always downloads the 2023 open bank (github.com/Ed0ardo/QuizPatenteB, MIT) for its 413 figures.
If data/listato.json exists (made by 00_sources.py from neca.it's ListatoAB.pdf, updated Feb 2025), the
questions and structure come from the official listato instead, and figures are inherited from the 2023 bank
by matching question text. Otherwise the 2023 bank is used as-is.

Run:  python pipeline/01_fetch_bank.py
Safe to re-run; images already on disk are skipped.
"""
import re
import sys
import unicodedata
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import httpx

from common import BANK, DATA, IMAGES, NECA_SECTIONS, SOURCE_REPO, TOPICS, canonical_section, load_json, save_json, slug_to_title

SRC_JSON = f"{SOURCE_REPO}/quizPatenteB2023.json"
LISTATO = DATA / "listato.json"


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower()).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def slugify(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", norm(t)).strip("-")[:50]


def section_meta(header: str):
    key = canonical_section(header)
    if key:
        return NECA_SECTIONS[key]
    return (slugify(header), header.title(), header.title())


def download(client: httpx.Client, url: str, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return "skip"
    r = client.get(url, timeout=60)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return "ok"


def bank_from_github(src):
    topic_meta = {slug: (it, en) for slug, it, en in TOPICS}
    topics, subtopics, questions = [], [], []
    for t_ord, (t_slug, sub_map) in enumerate(src.items(), start=1):
        it, en = topic_meta.get(t_slug, (slug_to_title(t_slug), slug_to_title(t_slug)))
        topic_id = f"t{t_ord:02d}"
        topics.append({"id": topic_id, "ord": t_ord, "slug": t_slug, "title_it": it, "title_en": en})
        for s_ord, (s_slug, qs) in enumerate(sub_map.items(), start=1):
            sub_id = f"{topic_id}-s{s_ord:03d}"
            sub_img = next((q.get("img") for q in qs if q.get("img")), None)
            subtopics.append({"id": sub_id, "topic_id": topic_id, "ord": s_ord, "slug": s_slug, "title_it": slug_to_title(s_slug),
                              "image": sub_img.split("/")[-1] if sub_img else None, "question_count": len(qs)})
            for q_ord, q in enumerate(qs, start=1):
                img = q.get("img")
                questions.append({"id": f"{sub_id}-q{q_ord:02d}", "subtopic_id": sub_id, "topic_id": topic_id, "ord": q_ord,
                                  "q_it": q["q"].strip(), "answer": bool(q["a"]), "image": img.split("/")[-1] if img else None})
    return {"topics": topics, "subtopics": subtopics, "questions": questions}


def bank_from_listato(listato, github_bank, image_names=frozenset()):
    """Official listato structure; figures inherited from the 2023 bank.

    The same sentence appears under several signs with different figures (e.g. "preannuncia un dosso" is TRUE
    for the dosso sign and FALSE for others), so a question's figure is decided per block: every question votes
    for the figures of the 2023 questions with the same text AND the same answer, and the block takes the majority.
    """
    by_text = {}
    for q in github_bank["questions"]:
        by_text.setdefault(norm(q["q_it"]), []).append((q["answer"], q["image"]))

    topics, subtopics, questions = [], [], []
    topic_by_slug, sub_ord = {}, Counter()
    stats = Counter()
    for b in listato["blocks"]:
        slug, it, en = section_meta(b["section"] or "ALTRO")
        if slug not in topic_by_slug:
            tid = f"t{len(topic_by_slug) + 1:02d}"
            topic_by_slug[slug] = tid
            topics.append({"id": tid, "ord": len(topics) + 1, "slug": slug, "title_it": it, "title_en": en})
        tid = topic_by_slug[slug]
        sub_ord[tid] += 1
        sid = f"{tid}-s{sub_ord[tid]:03d}"

        qs, votes = [], Counter()
        for i, q in enumerate(b["questions"], start=1):
            cands = [c for c in by_text.get(norm(q["text"]), []) if c[0] == bool(q["answer"])]
            for _, img in cands:
                if img:
                    votes[img] += 1.0 / len(cands)
            stats["matched" if cands else "new"] += 1
            qs.append({"id": f"{sid}-q{i:02d}", "subtopic_id": sid, "topic_id": tid, "ord": i, "q_it": q["text"],
                       "answer": bool(q["answer"]), "image": None, "matched_2023": bool(cands), "_cands": cands})
        block_img = votes.most_common(1)[0][0] if votes else None
        b["_block_img"] = block_img
        for q in qs:
            fig = re.search(r"\(FIG\s*(\d{3})\)", q["q_it"], re.IGNORECASE)   # supplementary figure named in the statement
            if fig and f"{fig.group(1)}.png" in image_names:
                q["image"] = f"{fig.group(1)}.png"
                stats["image_from_fig"] += 1
                del q["_cands"]
                continue
            imgs = {img for _, img in q["_cands"] if img}
            if block_img and (block_img in imgs or not imgs):
                q["image"] = block_img if (imgs or "raffigurat" in norm(q["q_it"]) or "figur" in norm(q["q_it"]) or "pannell" in norm(q["q_it"])) else None
            elif len(imgs) == 1:
                q["image"] = imgs.pop()
            elif imgs:
                q["image"] = block_img or sorted(imgs)[0]
            if not q["image"] and ("raffigurat" in norm(q["q_it"]) or "(fig" in q["q_it"].lower()):
                stats["image_missing"] += 1
            del q["_cands"]
        subtopics.append({"id": sid, "topic_id": tid, "ord": sub_ord[tid], "slug": f"{slugify(b['title'])}-{b['block']}",
                          "title_it": b["title"], "block": b["block"], "image": block_img, "question_count": len(qs), "_page": b.get("page"),
                          "_figs": [f for f in b.get("figures", []) if f < 900]})
        questions += qs

    # blocks with no 2023 match: use the "Figura N" printed on their page (the 2023 images are named by figure number)
    by_page = {}
    for st in subtopics:
        by_page.setdefault(st["_page"], []).append(st)
    q_by_sub = {}
    for q in questions:
        q_by_sub.setdefault(q["subtopic_id"], []).append(q)
    for page, sts in by_page.items():
        figs = []
        for st in sts:
            for f in st["_figs"]:
                if f not in figs:
                    figs.append(f)
        missing = [st for st in sts if not st["image"]]
        for i, st in enumerate(missing):
            fig = None
            if len(figs) == len(sts):
                fig = figs[sts.index(st)]
            elif len(figs) == 1:
                fig = figs[0]
            elif figs and i < len(figs):
                fig = figs[i]
            if fig and f"{fig}.png" in image_names:
                st["image"] = f"{fig}.png"
                for q in q_by_sub[st["id"]]:
                    if not q["image"] and ("raffigurat" in norm(q["q_it"]) or "figur" in norm(q["q_it"]) or "pannell" in norm(q["q_it"])):
                        q["image"] = st["image"]
                        stats["image_missing"] -= 1
                        stats["image_from_page"] += 1
    for st in subtopics:
        del st["_page"], st["_figs"]

    with_img = sum(1 for q in questions if q["image"])
    print(f"Listato bank: {len(topics)} topics, {len(subtopics)} stops, {len(questions)} questions, {with_img} with a figure")
    print(f"  {stats['matched']} questions identical to the 2023 bank, {stats['new']} new or reworded since 2023")
    print(f"  figures: {stats['image_from_fig']} from (FIG nnn) references, {stats['image_from_page']} from the page's Figura number, "
          f"{max(0, stats['image_missing'])} figure questions still without an image")
    return {"topics": topics, "subtopics": subtopics, "questions": questions, "source": f"neca listato {listato.get('updated')}"}


def main():
    print("Downloading the 2023 open bank (for figures)…")
    with httpx.Client(follow_redirects=True) as client:
        raw = client.get(SRC_JSON, timeout=120)
        raw.raise_for_status()
        github = bank_from_github(raw.json())
        images = {q["image"] for q in github["questions"] if q["image"]}

        if LISTATO.exists():
            bank = bank_from_listato(load_json(LISTATO), github, frozenset(images))
        else:
            bank = github
            bank["source"] = "github 2023"
            print(f"{len(bank['topics'])} topics, {len(bank['subtopics'])} sub-topics, {len(bank['questions'])} questions (2023 bank)")
        save_json(BANK, bank)
        print(f"Wrote {BANK}")

        print(f"Downloading {len(images)} images…")
        def job(name):
            return name, download(client, f"{SOURCE_REPO}/img_sign/{name}", IMAGES / name)
        done = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for _ in pool.map(job, sorted(images)):
                done += 1
                if done % 100 == 0:
                    print(f"  {done}/{len(images)}")
        print(f"Images in {IMAGES}")


if __name__ == "__main__":
    try:
        main()
    except httpx.HTTPError as e:
        print(f"Download failed: {e}", file=sys.stderr)
        sys.exit(1)
