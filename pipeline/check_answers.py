"""Check the app's Vero/Falso answers against an independent source.

The app's answers come from the official listato PDF, where a statement's answer is only its position on the page
(under DOMANDE VERE or DOMANDE FALSE), so a parse slip flips whole runs. This compares every question in the app's
database with the 2023 open bank (github.com/Ed0ardo/QuizPatenteB), which records each answer separately, matching
statements by their text. It also flags statements that appear twice in the app with opposite answers.

A disagreement is not automatically an app error: the Dec 2024 reform changed some rules, so questions marked
reform_check can legitimately differ from the 2023 bank. Everything else that disagrees deserves a look.

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (the same as 04_upload.py). Reads only; changes nothing.
Run:  python pipeline/check_answers.py              # every topic
      python pipeline/check_answers.py --topic t05  # one topic, every disagreement listed
      python pipeline/check_answers.py --local      # check data/bank.json (step 01's output) instead of the database
"""
import re
import sys
import unicodedata

import httpx
from supabase import create_client

from common import BANK, SOURCE_REPO, env, load_json


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower()).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


# "the sign shown…": the same words are true for one picture and false for another, so text alone cannot settle them
PICTURE = re.compile(r"raffigurat|rappresentat|in figura|illustrat|\bsimbolo\b|\bpannello\b")


def fetch_all(sb, table, cols):
    rows, start = [], 0
    while True:
        page = sb.table(table).select(cols).order("id").range(start, start + 999).execute().data
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


def bank_2023():
    src = httpx.get(f"{SOURCE_REPO}/quizPatenteB2023.json", timeout=60, follow_redirects=True).json()
    answers = {}
    for subs in src.values():
        for qs in subs.values():
            for q in qs:
                answers.setdefault(norm(q["q"]), set()).add(bool(q["a"]))
    return answers


def main():
    only = sys.argv[sys.argv.index("--topic") + 1] if "--topic" in sys.argv else None
    if "--local" in sys.argv:
        bank = load_json(BANK)
        all_t, all_s, all_q = bank["topics"], bank["subtopics"], bank["questions"]
    else:
        sb = create_client(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"))
        all_t = fetch_all(sb, "topics", "id,ord,title_en")
        all_s = fetch_all(sb, "subtopics", "id,ord,title_en")
        all_q = fetch_all(sb, "questions", "id,topic_id,subtopic_id,q_it,answer,reform_check")
    topics = {t["id"]: t for t in all_t}
    stops = {s["id"]: s for s in all_s}
    qs = [q for q in all_q if not only or q["topic_id"] == only]
    if not qs:
        sys.exit(f"No questions found{f' for topic {only}' if only else ''}.")
    ref = bank_2023()

    per, bad = {}, []
    for q in qs:
        d = per.setdefault(q["topic_id"], {"n": 0, "matched": 0, "agree": 0, "differ": 0, "picture": 0, "reform": 0})
        d["n"] += 1
        theirs = ref.get(norm(q["q_it"]))
        if not theirs or len(theirs) > 1:            # not in the 2023 bank, or the 2023 bank contradicts itself
            continue
        d["matched"] += 1
        if q["answer"] in theirs:
            d["agree"] += 1
        else:
            q["kind"] = "reform" if q.get("reform_check") else "picture" if PICTURE.search(q["q_it"].lower()) else "differ"
            d[q["kind"]] += 1
            bad.append(q)

    seen, clashes = {}, []
    for q in qs:
        if PICTURE.search(q["q_it"].lower()):
            continue
        k = norm(q["q_it"])
        if k in seen and seen[k]["answer"] != q["answer"]:
            clashes.append((seen[k], q))
        seen.setdefault(k, q)

    print(f"{'topic':6} {'questions':>9} {'matched':>8} {'agree':>6} {'differ':>7} {'picture':>8} {'reform':>7}  title")
    for tid, d in sorted(per.items(), key=lambda x: topics.get(x[0], {}).get("ord", 0)):
        print(f"{tid:6} {d['n']:9} {d['matched']:8} {d['agree']:6} {d['differ']:7} {d['picture']:8} {d['reform']:7}  {topics.get(tid, {}).get('title_en', '')}")
    tot = {k: sum(d[k] for d in per.values()) for k in ("n", "matched", "agree", "differ", "picture", "reform")}
    print(f"\n{tot['n']} questions · {tot['matched']} found in the 2023 bank · {tot['agree']} agree · "
          f"{tot['differ']} disagree · {tot['picture']} picture statements disagree (may be a different sign) · "
          f"{tot['reform']} disagree but are marked as reform-affected")

    for kind, label in (("differ", "Disagreements to look at"), ("picture", "Picture statements that disagree (check the sign)")):
        real = [q for q in bad if q["kind"] == kind]
        if not real:
            continue
        print(f"\n{label} ({len(real)}{', first 40' if len(real) > 40 and not only else ''}):")
        for q in real if only else real[:40]:
            s = stops.get(q["subtopic_id"], {})
            print(f"  {q['id']}  stop {s.get('ord')} · app says {'Vero' if q['answer'] else 'Falso'}, 2023 bank says "
                  f"{'Falso' if q['answer'] else 'Vero'}\n      {q['q_it']}")
    if clashes:
        print(f"\nSame statement, opposite answers inside the app ({len(clashes)}):")
        for a, b in clashes[:40]:
            print(f"  {a['id']} {'V' if a['answer'] else 'F'}  vs  {b['id']} {'V' if b['answer'] else 'F'}   {a['q_it']}")
    if not any(q["kind"] != "reform" for q in bad) and not clashes:
        print("\nNo disagreements outside the reform-affected questions, and no statement answered both ways.")


if __name__ == "__main__":
    main()
