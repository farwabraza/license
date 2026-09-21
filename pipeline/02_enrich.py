"""Step 02 — one Claude call per sub-topic (656 calls) producing:
  - an English lesson narration for the sub-topic with Italian terms marked as [[term]]
  - a glossary of the Italian terms used
  - for every question: English translation, trap words, trap type, one-line why

Output: data/enriched/<subtopic_id>.json (one file per sub-topic, resumable) and data/final.json.

Run:  python pipeline/02_enrich.py            # processes everything not done yet
      python pipeline/02_enrich.py t03        # only topic t03
      python pipeline/02_enrich.py --merge    # just rebuild final.json from what exists
Cost: roughly €15–20 on Sonnet, ~€5 on Haiku (set CLAUDE_MODEL in .env).
"""
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import anthropic

from common import BANK, ENRICHED, FINAL, MANUAL, REFORM_TOPICS, env, load_json, save_json

MODEL = env("CLAUDE_MODEL", "claude-sonnet-5")
CONCURRENCY = int(env("ENRICH_CONCURRENCY", "4"))

SYSTEM = """You write study material for the Italian driving-theory exam (patente B, quiz vero/falso) for an
English-speaking learner who lives in Italy and reads Italian at an intermediate level. The learner will hear your
narration read aloud by a text-to-speech voice, so write for the ear: short sentences, no bullet points, no markdown.

You receive one sub-topic: its Italian title, the topic it belongs to, whether it has an image, its questions with the
official true/false answers, and (when available) excerpts from Italian driving-school manuals. The manual excerpts are
your source of truth for rules, definitions, distances, speeds and penalties — take the facts from them, not from memory.
The official answers are ground truth for the questions: everything you write must be consistent with them, and if an
excerpt seems to conflict with an official answer, follow the answer and phrase the rule so both hold.

Return ONLY a JSON object with this shape and nothing else:
{
 "title_en": "short English title for the sub-topic (2-6 words)",
 "narration": "110-190 words of spoken English that teaches exactly what these questions test. Introduce every Italian
   technical term the questions use, written inside double square brackets the first time, like [[carreggiata]], and give
   its English meaning right after it in plain words. Say what the image shows if there is one. End with one sentence
   that names the trick the quiz plays in this cluster (the negation, the absolute word, the può-vs-deve swap, the
   wrong number, the swapped direction) and how to spot it.",
 "terms": [{"it": "carreggiata", "en": "roadway — the part of the road vehicles use", "note": "not corsia, which is one lane"}],
 "questions": [
   {"id": "the question id exactly as given",
    "en": "faithful English translation of the Italian statement",
    "trap_words": ["Italian words copied verbatim from the statement that decide true/false, e.g. non, anche, sempre, solo, può, deve, vietato, entro, oltre, destra, sinistra, mai, obbligatorio, consentito"],
    "trap_type": "one of: negation | absolute | modal | number | direction | definition | none",
    "why": "one sentence in English: why the official answer is Vero or Falso, naming the word that flips it if any",
    "reform_check": false}
 ]
}
Rules: include every question id you were given, once. trap_words must be exact substrings of the Italian statement
(2 words max, empty list if the statement is a plain definition). Keep "why" under 30 words. Set reform_check true only
if the statement concerns a rule changed by the December 2024 Codice della Strada reform (alcohol/drug penalties,
phone use at the wheel, short licence suspension, e-scooters, points) and its answer might now differ."""


# ---------- manual retrieval (simple tf-idf over section text) ----------
STOP = set("""a ad al alla alle allo agli ai anche che chi ci con come da dal dalla dalle dallo dai dei del della delle dello di
e ed è essere gli i il in la le lo ma me mi ne nei nel nella nelle nello non o per più può quale quando questa queste questi
questo se si sia sono su sua sue sui sul sulla sulle sullo suo tra un una uno via vi loro noi voi ha hanno essere sono
era erano viene vengono deve devono cui tutti tutte tutto tutta ogni oltre entro dopo prima fino senza sempre solo anche
segnale raffigurato figura presenza caso""".split())


def tokens(text: str):
    import unicodedata
    t = unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()
    return [w for w in re.findall(r"[a-z0-9]{3,}", t) if w not in STOP]


class ManualIndex:
    def __init__(self, sections):
        import math
        self.sections = sections
        self.tok = [set(tokens(s["title"] + " " + s["text"])) for s in sections]
        self.title_tok = [set(tokens(s["title"])) for s in sections]
        df = {}
        for ts in self.tok:
            for w in ts:
                df[w] = df.get(w, 0) + 1
        n = max(1, len(sections))
        self.idf = {w: math.log(1 + n / c) for w, c in df.items()}

    def search(self, query: str, k=4, max_words=1800, per_section=600):
        q = set(tokens(query))
        scored = []
        for i, ts in enumerate(self.tok):
            hit = q & ts
            if not hit:
                continue
            title_hit = q & self.title_tok[i]
            score = (sum(self.idf[w] for w in hit) + 3 * sum(self.idf[w] for w in title_hit)) / (len(ts) ** 0.45)
            score *= min(1.0, self.sections[i]["words"] / 80)          # very short sections carry little
            scored.append((score, i))
        scored.sort(reverse=True)
        out, used = [], 0
        for score, i in scored[:k]:
            sec = self.sections[i]
            words = sec["text"].split()
            take = min(per_section, max_words - used)
            if take < 60:
                break
            out.append({"book": sec["book"], "title": sec["title"], "text": " ".join(words[:take]) + (" …" if len(words) > take else "")})
            used += min(len(words), take)
        return out


MANUAL_INDEX = ManualIndex(load_json(MANUAL)) if MANUAL.exists() else None


def strip_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text


CHUNK = int(env("ENRICH_CHUNK", "12"))        # questions per call; big sign blocks have up to 54
MAX_TOKENS = int(env("ENRICH_MAX_TOKENS", "8000"))
FAILED = ENRICHED / "_failed"

SYSTEM_MORE = SYSTEM + """

THIS CALL: the lesson narration and terms for this sub-topic were already written (they are included for context).
Return ONLY {"questions": [...]} for the questions given, same per-question format and rules as above."""


def build_user_message(topic, sub, qs, bank_is_2023, total=None, context=None):
    payload = {
        "topic_it": topic["title_it"], "topic_en": topic["title_en"],
        "subtopic_title_it": sub.get("title_it") or sub["slug"], "has_image": bool(sub["image"]),
        "reform_topic": bank_is_2023 and topic["slug"] in REFORM_TOPICS,
        "questions_in_this_call": len(qs), "questions_in_subtopic": total or len(qs),
        "questions": [{"id": q["id"], "it": q["q_it"], "answer": "Vero" if q["answer"] else "Falso",
                       "has_image": bool(q["image"])} for q in qs],
    }
    if context:
        payload["narration_already_written"] = context["narration"]
        payload["terms_already_written"] = context["terms"]
    if MANUAL_INDEX:
        query = f"{sub.get('title_it', '')} {sub['slug'].replace('-', ' ')} " + " ".join(q["q_it"] for q in qs)
        payload["manual_excerpts"] = MANUAL_INDEX.search(query, max_words=1800 if not context else 1000)
    return json.dumps(payload, ensure_ascii=False)


def parse_json(text: str):
    text = strip_fences(text)
    try:
        return json.loads(text, strict=False)          # strict=False tolerates raw newlines inside strings
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1], strict=False)
        raise


def call_json(client, system, user, tag, want_ids, attempt=1):
    msg = client.messages.create(model=MODEL, max_tokens=MAX_TOKENS, system=system,
                                 messages=[{"role": "user", "content": user}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    problem = None
    data = None
    if msg.stop_reason == "max_tokens":
        problem = f"output cut off at {MAX_TOKENS} tokens"
    else:
        try:
            data = parse_json(text)
        except json.JSONDecodeError as e:
            problem = f"bad JSON ({e.msg} at char {e.pos})"
    if data is not None:
        got = {q.get("id") for q in data.get("questions", [])}
        if got != want_ids:
            problem = f"question ids mismatch (missing {sorted(want_ids - got)[:3]}, extra {sorted(got - want_ids)[:3]})"
    if problem:
        FAILED.mkdir(exist_ok=True)
        (FAILED / f"{tag}-try{attempt}.txt").write_text(text, encoding="utf-8")
        if attempt < 3:
            time.sleep(2 * attempt)
            return call_json(client, system, user, tag, want_ids, attempt + 1)
        raise ValueError(f"{tag}: {problem} after 3 tries — raw output saved in data/enriched/_failed/")
    return data


def call_claude(client, topic, sub, qs, bank_is_2023):
    """One sub-topic → narration + terms + all questions, in chunks of CHUNK questions per call."""
    chunks = [qs[i:i + CHUNK] for i in range(0, len(qs), CHUNK)]
    first = chunks[0]
    data = call_json(client, SYSTEM, build_user_message(topic, sub, first, bank_is_2023, total=len(qs)),
                     f"{sub['id']}-c1", {q["id"] for q in first})
    data["terms"] = data.get("terms", [])[:8]
    context = {"narration": data.get("narration", ""), "terms": data["terms"]}
    for n, chunk in enumerate(chunks[1:], start=2):
        more = call_json(client, SYSTEM_MORE, build_user_message(topic, sub, chunk, bank_is_2023, total=len(qs), context=context),
                         f"{sub['id']}-c{n}", {q["id"] for q in chunk})
        data["questions"] += more["questions"]
    order = {q["id"]: i for i, q in enumerate(qs)}
    data["questions"].sort(key=lambda q: order[q["id"]])
    for q in data["questions"]:
        q["trap_words"] = [w for w in q.get("trap_words", []) if w][:2]
        q.setdefault("trap_type", "none")
        q.setdefault("reform_check", False)
        q.setdefault("en", "")
        q.setdefault("why", "")
    return data


def merge():
    bank = load_json(BANK)
    subs_by_id = {s["id"]: s for s in bank["subtopics"]}
    q_by_id = {q["id"]: q for q in bank["questions"]}
    missing = 0
    for sub in bank["subtopics"]:
        p = ENRICHED / f"{sub['id']}.json"
        if not p.exists():
            missing += 1
            continue
        data = load_json(p)
        sub["title_en"] = data["title_en"]
        sub["narration"] = data["narration"]
        sub["terms"] = data["terms"]
        for eq in data["questions"]:
            q = q_by_id[eq["id"]]
            q["q_en"] = eq["en"]
            q["trap_words"] = eq["trap_words"]
            q["trap_type"] = eq["trap_type"]
            q["why_en"] = eq["why"]
            q["reform_check"] = bool(eq.get("reform_check"))
    save_json(FINAL, bank)
    print(f"Wrote {FINAL} ({len(bank['subtopics']) - missing}/{len(bank['subtopics'])} sub-topics enriched)")
    if missing:
        print(f"{missing} sub-topics still missing — run this step again without --merge.")


def main():
    if "--merge" in sys.argv:
        merge()
        return
    only_topic = next((a for a in sys.argv[1:] if a.startswith("t")), None)

    bank = load_json(BANK)
    topics = {t["id"]: t for t in bank["topics"]}
    qs_by_sub = {}
    for q in bank["questions"]:
        qs_by_sub.setdefault(q["subtopic_id"], []).append(q)

    bank_is_2023 = str(bank.get("source", "github")).startswith("github")
    todo = [s for s in bank["subtopics"]
            if not (ENRICHED / f"{s['id']}.json").exists()
            and (only_topic is None or s["topic_id"] == only_topic)]
    big = sum(1 for s_ in todo if len(qs_by_sub[s_["id"]]) > CHUNK)
    print(f"Model {MODEL} · {len(todo)} sub-topics to enrich ({big} need more than one call) · concurrency {CONCURRENCY} · "
          f"manual excerpts {'ON (' + str(len(MANUAL_INDEX.sections)) + ' sections)' if MANUAL_INDEX else 'OFF'} · bank {bank.get('source', 'github 2023')}")
    if not todo:
        merge()
        return

    client = anthropic.Anthropic(api_key=env("ANTHROPIC_API_KEY"))
    failures = []

    def job(sub):
        data = call_claude(client, topics[sub["topic_id"]], sub, qs_by_sub[sub["id"]], bank_is_2023)
        save_json(ENRICHED / f"{sub['id']}.json", data)
        return sub["id"]

    done = 0
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(job, s): s for s in todo}
        for fut in as_completed(futures):
            sub = futures[fut]
            try:
                fut.result()
                done += 1
                if done % 10 == 0 or done == len(todo):
                    print(f"  {done}/{len(todo)}")
            except Exception as e:  # noqa: BLE001
                failures.append((sub["id"], str(e)[:200]))
                print(f"  FAILED {sub['id']}: {e}")

    if failures:
        print(f"\n{len(failures)} failed — re-run the script to retry them.")
    merge()


if __name__ == "__main__":
    main()
