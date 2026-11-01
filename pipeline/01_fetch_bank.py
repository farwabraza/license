"""Step 01 — build data/bank.json.

Always downloads the 2023 open bank (github.com/Ed0ardo/QuizPatenteB, MIT) for its 413 figures.
If data/listato.json exists (made by 00_sources.py from neca.it's ListatoAB.pdf, updated Feb 2025), the
questions and structure come from the official listato instead, and each stop gets at most one of the 2023
bank's figures, chosen from the listato's own "Figura N" numbers first and from the 2023 bank's question text
and sign titles after that (a stop with no trustworthy figure gets none). Otherwise the 2023 bank is used as-is.

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


_STOP = {"di", "e", "ed", "a", "al", "alla", "alle", "ai", "del", "della", "delle", "dei", "degli", "sul", "sulla", "sulle", "sui",
         "con", "per", "in", "la", "le", "il", "lo", "i", "da", "su", "o", "un", "una", "comportamento"}


def title_stems(t: str) -> frozenset:
    """Content words of a title cut to 5 letters, so 'sorpasso' / 'sorpassare' and 'veicoli' / 'veicolo' meet."""
    return frozenset(w[:5] for w in norm(t).split() if w not in _STOP)


def own_figure_numbers(title: str, image_names) -> set:
    """'Ordine di precedenza nell'intersezione n. 607' names its own figure."""
    return {m for m in re.findall(r"\bn\.?\s*(\d{3})\b", title) if f"{m}.png" in image_names}


def sign_index(github_bank, image_names):
    """One entry per 2023 sub-topic that is about a single sign: its slug words, its topic's words and its image. That
    is the commonest numbered figure of its questions, when at least 5 of them carry it and it is 80% of the sub-topic's
    pictures; the 9xx files are supplementary pictures, and a sub-topic with a spread of figures (a situation, a rule)
    is not a sign. Only a sign's title can name a sign's image."""
    imgs = {}
    for q in github_bank["questions"]:
        if q["image"] and int(q["image"].split(".")[0]) < 900:
            imgs.setdefault(q["subtopic_id"], Counter())[q["image"]] += 1
    slug_of = {t["id"]: t["slug"] for t in github_bank["topics"]}
    out = []
    for s in github_bank["subtopics"]:
        c = imgs.get(s["id"])
        if c:
            img, n = c.most_common(1)[0]
            if img in image_names and n >= 5 and n >= 0.8 * sum(c.values()):
                out.append((title_stems(s["slug"].replace("-", " ")), title_stems(slug_of[s["topic_id"]].replace("-", " ")), img))
    return out


def same_family(a: frozenset, b: frozenset) -> bool:
    """Do two topic names share their words ('segnali-divieto' / 'segnali-divieto'; 'segnaletica-orizzontale-ostacoli' /
    'segnali-orizzontali')? The listato and the 2023 bank cut the course differently, so this is a fuzzy test."""
    return len(a & b) / max(len(a | b), 1) >= 0.5


def title_match(title: str, section_slug: str, index):
    """(image, score) of the 2023 sign whose slug the listato title names, or None when it is not clear-cut. Only signs
    of the same family as the block's section count ('Inversione di marcia' in the lanes section is a manoeuvre, not
    the 'inversione-marcia' information sign). Every word of the sign's slug must be in the title ('Uso degli indicatori
    di direzione' is not the 'simbolo-indicatori-direzione' dashboard symbol), and no sign with a different image may
    match as well: 'Fine divieto di sorpasso' names fine-divieto-sorpasso, not divieto-sorpasso, by having more words."""
    t, sec = title_stems(title), title_stems(section_slug.replace("-", " "))
    scored = []
    for stems, topic_stems, img in index:
        common = len(t & stems)
        if stems and common == len(stems) and same_family(sec, topic_stems):
            scored.append(((common / len(stems), common), img))
    if not scored:
        return None
    scored.sort(reverse=True)
    best, img = scored[0]
    if any(s >= best for s, i in scored if i != img):
        return None
    return img, best[0] + 0.01 * best[1]


def best_assignment(weights):
    """Max-weight matching of one page: blocks (rows) to figures (columns), each figure to at most one block, each block
    to at most one figure, only over pairs with positive weight. Pages hold a handful of each, so a bitmask search is exact.
    Returns, per block, the column it takes or None."""
    n, m = len(weights), len(weights[0]) if weights else 0
    memo = {}

    def go(i, used):
        if i == n:
            return 0.0, ()
        if (i, used) not in memo:
            s, rest = go(i + 1, used)
            options = [(round(s, 6), 0, 0, (None,) + rest)]
            for j in range(m):
                if weights[i][j] > 0 and not used >> j & 1:
                    s, rest = go(i + 1, used | 1 << j)
                    options.append((round(s + weights[i][j], 6), 1, -j, (j,) + rest))
            best = max(options, key=lambda o: o[:3])          # on a tie the earlier block takes a figure, and the earlier figure
            memo[i, used] = (best[0], best[3])
        return memo[i, used]

    return go(0, 0)[1]


def choose_block_images(blocks, topic_of, section_slug, votes, index, image_names, stats):
    """One image (or none) per listato block, from the strongest evidence down. Returns {block id: (image, source)}.

    Two stops of one topic never end up with the same image unless the listato prints that figure number for both
    (page assignment, below) or one of them is the (comportamento) twin of the other under the same printed figure.
    Where the evidence runs out the stop gets no image: a figure question next to the wrong sign teaches the wrong
    answer, which is worse than a missing picture.
    """
    pick, taken = {}, {}          # taken: topic -> images already held there
    own_nums = {b["block"]: own_figure_numbers(b["title"], image_names) for b in blocks}
    tmatch = {b["block"]: title_match(b["title"], section_slug[b["block"]], index) for b in blocks}
    named = {}                                               # the figure its statements name, when they name only one
    for b in blocks:
        c = {f"{int(m)}.png" for q in b["questions"] for m in re.findall(r"\(FIG\s*(\d{1,3})\)", q["text"], re.IGNORECASE) if int(m) < 900}
        if len(c) == 1:                                      # a block citing several figures has no one picture of its own
            named[b["block"]] = c.pop()

    def vote_of(bid):
        v = votes[bid]
        mass = sum(v.values())
        return v, mass

    def give(b, img, source):
        pick[b["block"]] = (img, source)
        taken.setdefault(topic_of[b["block"]], set()).add(img)
        stats["block_" + source] += 1

    # 2. the figure numbers printed on the block's own listato page. One page = a few blocks and a few figures, in the
    # same order, so each figure goes to at most one block of its page. When there are as many figures as blocks the
    # order decides (it agrees with the 2023 votes on 240 of 249 such blocks). With a different count the order says
    # nothing (a lone figure is the first block's as often as the second's), so only the evidence can place a figure.
    pages = {}
    for b in blocks:
        pages.setdefault(b["page"], []).append(b)
    page_figs = {}
    for page, bs in pages.items():
        figs = []
        for f in bs[0].get("figures", []):
            if f < 900 and f"{f}.png" in image_names and f"{f}.png" not in figs:
                figs.append(f"{f}.png")
        for b in bs:                                         # a figure named in a title belongs on the page too
            figs += [f"{m}.png" for m in own_nums[b["block"]] if f"{m}.png" not in figs]
        page_figs[page] = figs
        if not figs:
            continue
        rows = []
        for i, b in enumerate(bs):
            v, mass = vote_of(b["block"])
            row = []
            for j, f in enumerate(figs):
                w = 0.0
                if i == j and len(bs) == len(figs):
                    w += 1.0                                 # same position on the page
                if f[:-4] in own_nums[b["block"]]:
                    w += 4.0                                 # the title says the figure's number
                if named.get(b["block"]) == f:
                    w += 3.0                                 # its statements say "(FIG nnn)" for this one
                if tmatch[b["block"]] and tmatch[b["block"]][0] == f:
                    w += 2.0                                 # the sign the title names is this one
                if mass >= 2 and v[f] / mass >= 0.4:
                    w += 2.0 * v[f] / mass                   # identical statements carried this figure in 2023
                row.append(w)
            rows.append(row)
        for b, j in zip(bs, best_assignment(rows)):
            if j is not None:
                give(b, figs[j], "page")

    # 3. the title. First the twin: "X (comportamento)" is the behaviour stop of "X" and shows the same sign, so it
    # takes the figure of its neighbour with the same title on the same page, which the page printed once for the pair.
    # (Same page only: a run of "Cambio di corsia" stops over two pages can be two different drawings.)
    def twin_key(b):
        return norm(re.sub(r"\(comportamento\)", "", b["title"], flags=re.IGNORECASE))

    for k, b in enumerate(blocks):
        if b["block"] in pick:
            continue
        for nb in (blocks[k - 1] if k else None, blocks[k + 1] if k + 1 < len(blocks) else None):
            if not nb or nb["block"] not in pick or pick[nb["block"]][1] != "page":
                continue
            if nb["page"] != b["page"] or topic_of[nb["block"]] != topic_of[b["block"]] or twin_key(nb) != twin_key(b):
                continue
            v, mass = vote_of(b["block"])
            if mass >= 2 and v and v.most_common(1)[0][0] != pick[nb["block"]][0] and v.most_common(1)[0][1] / mass >= 0.5:
                continue                                                  # its own statements point to another sign
            pick[b["block"]] = (pick[nb["block"]][0], "twin")
            stats["block_twin"] += 1
            break
    # then the 2023 sub-topic whose slug names the same sign, strongest match first, never onto an image already
    # held by another stop of the topic
    cands = sorted((b for b in blocks if b["block"] not in pick and tmatch[b["block"]]), key=lambda b: -tmatch[b["block"]][1])
    for b in cands:
        img = tmatch[b["block"]][0]
        if img not in taken.get(topic_of[b["block"]], ()):
            give(b, img, "title")
        else:
            stats["block_collision"] += 1

    # 4. last, the vote of identical 2023 statements, on the same terms
    voted = sorted((b for b in blocks if b["block"] not in pick and vote_of(b["block"])[0]), key=lambda b: -vote_of(b["block"])[1])
    for b in voted:
        v, mass = vote_of(b["block"])
        img, n = v.most_common(1)[0]
        if mass < 2 or n / mass < 0.5:
            stats["block_vote_weak"] += 1
        elif img in taken.get(topic_of[b["block"]], ()):
            stats["block_collision"] += 1
        else:
            give(b, img, "vote")
    return pick


def bank_from_listato(listato, github_bank, image_names=frozenset()):
    """Official listato structure; figures inherited from the 2023 bank and the listato's own pages.

    The same sentence appears under several signs with different figures (e.g. "preannuncia un dosso" is TRUE
    for the dosso sign and FALSE for others), so counting votes of identical statements over a whole block lets a
    popular sign swallow its neighbours, and handing every block of a page the page's figure numbers does the same.
    Each block therefore gets one image from evidence taken strongest-first (see choose_block_images), and a
    question shows its block's image when it is a figure question or when the 2023 bank had that statement with it.
    """
    by_text = {}
    for q in github_bank["questions"]:
        by_text.setdefault(norm(q["q_it"]), []).append((q["answer"], q["image"]))
    index = sign_index(github_bank, image_names)

    topics, subtopics, questions = [], [], []
    topic_by_slug, sub_ord = {}, Counter()
    stats = Counter()
    topic_of, section_slug, votes, q_by_block = {}, {}, {}, {}
    for b in listato["blocks"]:
        slug, it, en = section_meta(b["section"] or "ALTRO")
        section_slug[b["block"]] = slug
        if slug not in topic_by_slug:
            tid = f"t{len(topic_by_slug) + 1:02d}"
            topic_by_slug[slug] = tid
            topics.append({"id": tid, "ord": len(topics) + 1, "slug": slug, "title_it": it, "title_en": en})
        tid = topic_by_slug[slug]
        sub_ord[tid] += 1
        sid = f"{tid}-s{sub_ord[tid]:03d}"
        topic_of[b["block"]] = tid

        qs, votes[b["block"]] = [], Counter()
        for i, q in enumerate(b["questions"], start=1):
            cands = [c for c in by_text.get(norm(q["text"]), []) if c[0] == bool(q["answer"])]
            for _, img in cands:
                if img:
                    votes[b["block"]][img] += 1.0 / len(cands)
            stats["matched" if cands else "new"] += 1
            qs.append({"id": f"{sid}-q{i:02d}", "subtopic_id": sid, "topic_id": tid, "ord": i, "q_it": q["text"],
                       "answer": bool(q["answer"]), "image": None, "matched_2023": bool(cands), "_imgs": {img for _, img in cands if img}})
        q_by_block[b["block"]] = qs
        subtopics.append({"id": sid, "topic_id": tid, "ord": sub_ord[tid], "slug": f"{slugify(b['title'])}-{b['block']}",
                          "title_it": b["title"], "block": b["block"], "image": None, "question_count": len(qs)})
        questions += qs

    pick = choose_block_images(listato["blocks"], topic_of, section_slug, votes, index, image_names, stats)

    for st in subtopics:
        block_img = pick.get(st["block"], (None, None))[0]
        st["image"] = block_img
        for q in q_by_block[st["block"]]:
            fig = re.search(r"\(FIG\s*(\d{1,3})\)", q["q_it"], re.IGNORECASE)   # supplementary figure named in the statement
            figure_q = any(w in norm(q["q_it"]) for w in ("raffigurat", "figur", "pannell"))
            if fig and f"{int(fig.group(1))}.png" in image_names:
                q["image"] = f"{int(fig.group(1))}.png"
                stats["image_from_fig"] += 1
            elif block_img and (figure_q or block_img in q["_imgs"]):
                q["image"] = block_img
            if not q["image"] and ("raffigurat" in norm(q["q_it"]) or "(fig" in q["q_it"].lower()):
                stats["image_missing"] += 1
            del q["_imgs"]

    # the rule the assignment above is meant to guarantee, checked on the result: inside a topic an image is held by
    # one stop, unless the listato printed that figure for each of them (page) or they are twins on one page
    held = {}
    for st in subtopics:
        if st["image"]:
            held.setdefault((st["topic_id"], st["image"]), []).append(st)
    for sts in held.values():
        if len(sts) > 1:
            stats["shared_images"] += 1
            stats["shared_stops"] += len(sts)
            if any(pick[s["block"]][1] not in ("page", "twin") for s in sts):
                stats["shared_unexplained"] += len(sts)

    with_img = sum(1 for q in questions if q["image"])
    print(f"Listato bank: {len(topics)} topics, {len(subtopics)} stops, {len(questions)} questions, {with_img} with a figure")
    print(f"  {stats['matched']} questions identical to the 2023 bank, {stats['new']} new or reworded since 2023")
    print(f"  stop images: {stats['block_page']} from the listato page's Figura numbers, {stats['block_twin']} from the (comportamento) twin, "
          f"{stats['block_title']} from the sign's title, {stats['block_vote']} from identical 2023 statements; "
          f"{len(subtopics) - len(pick)} stops left without an image ({stats['block_collision']} candidates refused: image already held in the topic)")
    print(f"  {stats['image_from_fig']} question figures from (FIG nnn) references, "
          f"{stats['image_missing']} figure questions without an image")
    print(f"  images held by more than one stop of a topic: {stats['shared_images']} ({stats['shared_stops']} stops), "
          f"{stats['shared_unexplained']} of those stops not backed by the listato's own figure or a same-page twin")
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
