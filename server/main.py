"""STRADA server v2 — FastAPI app serving the PWA and a JSON API over Supabase.

Run locally:  uvicorn server.main:app --reload --port 8000
Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY (optional, enables Ask tutor), CLAUDE_MODEL
"""
import json
import os
import random
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
WEB = ROOT / "web"

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY (in .env locally, or Secrets/Environment on the host).")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
app = FastAPI(title="STRADA")

LEITNER_DAYS = [0, 1, 3, 7, 14, 30]
EXAM_SIZE = int(os.getenv("EXAM_SIZE", "30"))
EXAM_MINUTES = int(os.getenv("EXAM_MINUTES", "20"))
EXAM_MAX_ERRORS = int(os.getenv("EXAM_MAX_ERRORS", "3"))
STOP_PASS_PCT = int(os.getenv("STOP_PASS_PCT", "90"))          # first-try accuracy needed to pass a stop's quiz
TOPIC_TEST_SIZE = int(os.getenv("TOPIC_TEST_SIZE", "10"))
TOPIC_TEST_MAX_ERRORS = int(os.getenv("TOPIC_TEST_MAX_ERRORS", "3"))
REPAIR_SIZE = int(os.getenv("REPAIR_SIZE", "10"))

# words the ministry uses to flip a statement; distractors for the "find the trap" exercise
TRAP_POOL = ["non", "anche", "sempre", "solo", "mai", "può", "deve", "vietato", "consentito", "obbligatorio",
             "entro", "oltre", "destra", "sinistra", "prima", "dopo", "tutti", "alcuni", "soltanto", "almeno"]

# ---------- helpers ----------

def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat()


def chunks(xs, n=200):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def fetch_all(table, select="*", page=1000, **eq):
    out, start = [], 0
    while True:
        q = sb.table(table).select(select).range(start, start + page - 1)
        for k, v in eq.items():
            q = q.eq(k, v)
        rows = q.execute().data
        out.extend(rows)
        if len(rows) < page:
            return out
        start += page


def rows_by_ids(table, ids, key="id", select="*"):
    rows = []
    for c in chunks(list(ids)):
        rows.extend(sb.table(table).select(select).in_(key, c).execute().data)
    return rows


def questions_by_ids(ids):
    return rows_by_ids("questions", ids)


def progress_map(user, ids, table="progress", key="question_id"):
    m = {}
    for c in chunks(list(ids)):
        for r in sb.table(table).select("*").eq("user_id", user).in_(key, c).execute().data:
            m[r[key]] = r
    return m


_QUESTION_INDEX = []


def question_index():
    global _QUESTION_INDEX
    if not _QUESTION_INDEX:
        _QUESTION_INDEX = [(r["id"], r["topic_id"]) for r in fetch_all("questions", "id,topic_id")]
    return _QUESTION_INDEX


def leitner(table, key, user, item_id, correct):
    rows = sb.table(table).select("*").eq("user_id", user).eq(key, item_id).execute().data
    p = rows[0] if rows else {"user_id": user, key: item_id, "box": 0, "streak": 0, "seen": 0, "wrong": 0}
    p["seen"] += 1
    if correct:
        p["box"] = min(p["box"] + 1, len(LEITNER_DAYS) - 1)
        p["streak"] += 1
    else:
        p["box"] = 0
        p["streak"] = 0
        p["wrong"] += 1
    p["last_seen"] = iso(now())
    p["due"] = iso(now() + timedelta(days=LEITNER_DAYS[p["box"]]))
    sb.table(table).upsert(p).execute()
    return p


def stop_progress(user):
    return {r["subtopic_id"]: r for r in fetch_all("subtopic_progress", "*", user_id=user)}


def mastered_topics(user):
    rows = sb.table("sessions").select("ref_id").eq("user_id", user).eq("kind", "topic_test").eq("passed", True).execute().data
    return {r["ref_id"] for r in rows}


# ---------- models ----------

class Answer(BaseModel):
    user: str
    question_id: str
    correct: bool


class Answers(BaseModel):
    user: str
    answers: list[Answer]


class TermAnswer(BaseModel):
    user: str
    term_id: str
    correct: bool


class QuizResult(BaseModel):
    correct: int
    total: int


class SubtopicProgress(BaseModel):
    user: str
    subtopic_id: str
    lesson_done: Optional[bool] = None
    review_done: Optional[bool] = None
    quiz_result: Optional[QuizResult] = None


class Session(BaseModel):
    user: str
    kind: str
    ref_id: Optional[str] = None
    correct: int
    total: int
    passed: Optional[bool] = None
    detail: Optional[dict] = None


class TutorAsk(BaseModel):
    user: str
    question_id: str
    user_answer: bool


# ---------- course structure ----------

@app.get("/api/health")
def health():
    return {"ok": True, "tutor": bool(ANTHROPIC_KEY),
            "exam": {"size": EXAM_SIZE, "minutes": EXAM_MINUTES, "max_errors": EXAM_MAX_ERRORS},
            "stop_pass_pct": STOP_PASS_PCT,
            "topic_test": {"size": TOPIC_TEST_SIZE, "max_errors": TOPIC_TEST_MAX_ERRORS}}


@app.get("/api/topics")
def topics(user: str = Query(...)):
    ts = sb.table("topics").select("*").order("ord").execute().data
    subs = fetch_all("subtopics", "id,topic_id,question_count")
    prog = stop_progress(user)
    mastered = mastered_topics(user)
    for t in ts:
        mine = [s for s in subs if s["topic_id"] == t["id"]]
        t["subtopics"] = len(mine)
        t["questions"] = sum(s["question_count"] for s in mine)
        t["lesson_done"] = sum(1 for s in mine if prog.get(s["id"], {}).get("lesson_done"))
        t["passed"] = sum(1 for s in mine if prog.get(s["id"], {}).get("quiz_passed"))
        t["mastered"] = t["id"] in mastered
    return ts


@app.get("/api/topics/{tid}")
def topic(tid: str, user: str = Query(...)):
    t = sb.table("topics").select("*").eq("id", tid).execute().data
    if not t:
        raise HTTPException(404, "topic not found")
    subs = sb.table("subtopics").select("id,topic_id,ord,slug,title_it,title_en,image_url,question_count,audio_url") \
        .eq("topic_id", tid).order("ord").execute().data
    prog = stop_progress(user)
    for s in subs:
        p = prog.get(s["id"], {})
        for k in ("lesson_done", "review_done", "quiz_passed"):
            s[k] = bool(p.get(k))
        s["best_accuracy"] = p.get("best_accuracy")
        s["attempts"] = p.get("attempts", 0)
    return {"topic": t[0], "subtopics": subs, "mastered": tid in mastered_topics(user)}


@app.get("/api/subtopics/{sid}")
def subtopic(sid: str, user: str = Query(...)):
    s = sb.table("subtopics").select("*").eq("id", sid).execute().data
    if not s:
        raise HTTPException(404, "sub-topic not found")
    s = s[0]
    qs = sb.table("questions").select("*").eq("subtopic_id", sid).order("ord").execute().data
    pm = progress_map(user, [q["id"] for q in qs])
    for q in qs:
        p = pm.get(q["id"])
        q["box"] = p["box"] if p else 0
        q["wrong"] = p["wrong"] if p else 0

    def key(q):
        p = pm.get(q["id"])
        if not p:
            return (1, 0)
        if p["due"] <= iso(now()):
            return (0, -p["wrong"])
        return (2, -p["box"])
    qs.sort(key=key)

    terms = sb.table("terms").select("*").contains("subtopic_ids", json.dumps([sid])).execute().data
    tpm = progress_map(user, [t["id"] for t in terms], "term_progress", "term_id")
    for t in terms:
        t["box"] = tpm.get(t["id"], {}).get("box", 0)

    siblings = sb.table("subtopics").select("id,ord,title_en").eq("topic_id", s["topic_id"]).order("ord").execute().data
    idx = next(i for i, x in enumerate(siblings) if x["id"] == sid)
    s["prev"] = siblings[idx - 1] if idx > 0 else None
    s["next"] = siblings[idx + 1] if idx + 1 < len(siblings) else None
    prog = sb.table("subtopic_progress").select("*").eq("user_id", user).eq("subtopic_id", sid).execute().data
    prev_prog = None
    if s["prev"]:
        pp = sb.table("subtopic_progress").select("quiz_passed").eq("user_id", user).eq("subtopic_id", s["prev"]["id"]).execute().data
        prev_prog = bool(pp and pp[0]["quiz_passed"])
    t = sb.table("topics").select("id,title_en,title_it").eq("id", s["topic_id"]).execute().data[0]
    return {"subtopic": s, "topic": t, "questions": qs, "terms": terms,
            "progress": prog[0] if prog else None, "prev_passed": prev_prog}


# ---------- stage 2: review exercises ----------

def blank_trap(statement, word):
    m = re.search(rf"(?<![\w'])({re.escape(word)})(?![\w])", statement, re.IGNORECASE)
    if not m:
        return None
    return statement[:m.start()] + "______" + statement[m.end():]


@app.get("/api/review_set/{sid}")
def review_set(sid: str, user: str = Query(...)):
    s = sb.table("subtopics").select("id,topic_id").eq("id", sid).execute().data
    if not s:
        raise HTTPException(404, "sub-topic not found")
    topic_id = s[0]["topic_id"]
    terms = sb.table("terms").select("*").contains("subtopic_ids", json.dumps([sid])).execute().data
    pool = [t for t in sb.table("terms").select("id,it,en").eq("topic_id", topic_id).limit(300).execute().data
            if t["id"] not in {x["id"] for x in terms}]
    if len(pool) < 6:
        pool += [t for t in sb.table("terms").select("id,it,en").limit(200).execute().data
                 if t["id"] not in {x["id"] for x in terms} and t not in pool]
    random.shuffle(pool)

    exercises = []
    for i, t in enumerate(terms[:8]):
        kind = "w2m" if i % 2 == 0 else "m2w"
        field = "en" if kind == "w2m" else "it"
        distractors = [d[field] for d in pool if d[field] != t[field]][:3]
        while len(distractors) < 3:
            distractors.append("—")
        options = distractors + [t[field]]
        random.shuffle(options)
        exercises.append({
            "type": kind, "term_id": t["id"], "it": t["it"], "en": t["en"], "note": t.get("note"),
            "prompt": t["it"] if kind == "w2m" else t["en"],
            "options": options, "answer_index": options.index(t[field]),
        })

    qs = [q for q in sb.table("questions").select("id,q_it,answer,q_en,why_en,trap_words,trap_type,image_url")
          .eq("subtopic_id", sid).execute().data if q["trap_words"]]
    random.shuffle(qs)
    for q in qs[:6]:
        word = q["trap_words"][0]
        blanked = blank_trap(q["q_it"], word)
        if not blanked:
            continue
        low = q["q_it"].lower()
        distractors = [w for w in TRAP_POOL if w != word.lower() and not re.search(rf"\b{re.escape(w)}\b", low)]
        random.shuffle(distractors)
        options = distractors[:3] + [word]
        random.shuffle(options)
        exercises.append({
            "type": "trap", "question_id": q["id"], "prompt": blanked, "options": options,
            "answer_index": options.index(word), "q_it": q["q_it"], "answer": q["answer"],
            "q_en": q["q_en"], "why_en": q["why_en"], "trap_words": q["trap_words"], "image_url": q["image_url"],
        })
    # words first, then traps
    return {"exercises": exercises, "terms": len(terms[:8]), "traps": len(exercises) - len(terms[:8])}


@app.post("/api/term_answer")
def term_answer(a: TermAnswer):
    p = leitner("term_progress", "term_id", a.user, a.term_id, a.correct)
    return {"box": p["box"], "due": p["due"]}


# ---------- answers & progress ----------

@app.post("/api/answer")
def answer(a: Answer):
    p = leitner("progress", "question_id", a.user, a.question_id, a.correct)
    return {"box": p["box"], "wrong": p["wrong"], "due": p["due"]}


@app.post("/api/answers")
def answers(b: Answers):
    for a in b.answers:
        leitner("progress", "question_id", b.user, a.question_id, a.correct)
    return {"ok": True, "n": len(b.answers)}


@app.post("/api/subtopic_progress")
def subtopic_progress(sp: SubtopicProgress):
    rows = sb.table("subtopic_progress").select("*").eq("user_id", sp.user).eq("subtopic_id", sp.subtopic_id).execute().data
    r = rows[0] if rows else {"user_id": sp.user, "subtopic_id": sp.subtopic_id, "lesson_done": False,
                              "review_done": False, "quiz_passed": False, "best_accuracy": None, "attempts": 0}
    if sp.lesson_done is not None:
        r["lesson_done"] = sp.lesson_done
    if sp.review_done is not None:
        r["review_done"] = sp.review_done
    passed_now = None
    if sp.quiz_result:
        acc = round(100 * sp.quiz_result.correct / max(1, sp.quiz_result.total))
        r["attempts"] += 1
        r["best_accuracy"] = max(acc, r["best_accuracy"] or 0)
        passed_now = acc >= STOP_PASS_PCT
        r["quiz_passed"] = r["quiz_passed"] or passed_now
        r["lesson_done"] = True
        sb.table("sessions").insert({"user_id": sp.user, "kind": "quiz", "ref_id": sp.subtopic_id, "finished_at": iso(now()),
                                     "correct": sp.quiz_result.correct, "total": sp.quiz_result.total, "passed": passed_now}).execute()
    r["updated_at"] = iso(now())
    sb.table("subtopic_progress").upsert(r).execute()
    r["passed_now"] = passed_now
    r["pass_pct"] = STOP_PASS_PCT
    return r


# ---------- tests ----------

@app.get("/api/review")
def review(user: str = Query(...), n: int = 30):
    due = sb.table("progress").select("question_id,wrong,box,due").eq("user_id", user) \
        .lte("due", iso(now())).order("due").limit(n).execute().data
    ids = [r["question_id"] for r in due]
    if len(ids) < n:
        more = sb.table("progress").select("question_id").eq("user_id", user).gt("wrong", 0) \
            .order("wrong", desc=True).limit(n * 2).execute().data
        for r in more:
            if r["question_id"] not in ids:
                ids.append(r["question_id"])
            if len(ids) >= n:
                break
    qs = questions_by_ids(ids)
    order = {qid: i for i, qid in enumerate(ids)}
    qs.sort(key=lambda q: order[q["id"]])
    return {"questions": qs, "due_count": len(due)}


@app.get("/api/exam")
def exam(n: int = 0):
    n = n or EXAM_SIZE
    idx = question_index()
    picked = random.sample(idx, min(n, len(idx)))
    qs = questions_by_ids([qid for qid, _ in picked])
    random.shuffle(qs)
    return {"questions": qs, "minutes": EXAM_MINUTES, "max_errors": EXAM_MAX_ERRORS}


@app.get("/api/topic_test/{tid}")
def topic_test(tid: str):
    ids = [qid for qid, t in question_index() if t == tid]
    if not ids:
        raise HTTPException(404, "topic not found")
    qs = questions_by_ids(random.sample(ids, min(TOPIC_TEST_SIZE, len(ids))))
    random.shuffle(qs)
    return {"questions": qs, "minutes": None, "max_errors": TOPIC_TEST_MAX_ERRORS}


@app.get("/api/repair")
def repair(user: str = Query(...)):
    prog = fetch_all("progress", "question_id,seen,wrong", user_id=user)
    if len(prog) < 10:
        raise HTTPException(400, "Do a few stops first — a repair test needs some mistake history to work from.")
    qmeta = {q["id"]: q["topic_id"] for q in rows_by_ids("questions", [p["question_id"] for p in prog], select="id,topic_id")}
    per = {}
    for p in prog:
        t = qmeta.get(p["question_id"])
        if not t:
            continue
        d = per.setdefault(t, {"seen": 0, "wrong": 0})
        d["seen"] += p["seen"]
        d["wrong"] += p["wrong"]
    ranked = sorted(per.items(), key=lambda kv: (-(kv[1]["wrong"] / max(1, kv[1]["seen"])), -kv[1]["wrong"]))
    weak = [t for t, _ in ranked[:2]] or [t for t, _ in ranked[:1]]
    wrong_ids = [p["question_id"] for p in prog if p["wrong"] > 0 and qmeta.get(p["question_id"]) in weak]
    random.shuffle(wrong_ids)
    ids = wrong_ids[:REPAIR_SIZE]
    if len(ids) < REPAIR_SIZE:
        seen = {p["question_id"] for p in prog}
        unseen = [qid for qid, t in question_index() if t in weak and qid not in seen]
        random.shuffle(unseen)
        ids += unseen[:REPAIR_SIZE - len(ids)]
    qs = questions_by_ids(ids)
    random.shuffle(qs)
    titles = [t["title_en"] for t in rows_by_ids("topics", weak, select="id,title_en")]
    return {"questions": qs, "minutes": None, "max_errors": TOPIC_TEST_MAX_ERRORS, "topics": titles, "topic_ids": weak}


@app.post("/api/session")
def session(s: Session):
    row = {"user_id": s.user, "kind": s.kind, "ref_id": s.ref_id, "finished_at": iso(now()),
           "correct": s.correct, "total": s.total, "passed": s.passed, "detail": s.detail}
    sb.table("sessions").insert(row).execute()
    return {"ok": True}


# ---------- words (flashcards) ----------

@app.get("/api/words")
def words(user: str = Query(...), n: int = 20):
    due = sb.table("term_progress").select("term_id,box").eq("user_id", user).lte("due", iso(now())).order("due").limit(n).execute().data
    ids = [r["term_id"] for r in due]
    boxes = {r["term_id"]: r["box"] for r in due}
    new_count = 0
    if len(ids) < n:
        done_stops = [sid for sid, p in stop_progress(user).items() if p.get("lesson_done")]
        known = {r["term_id"] for r in fetch_all("term_progress", "term_id", user_id=user)}
        candidates = []
        for c in chunks(done_stops, 40):
            for sid in c:
                for t in sb.table("terms").select("id").contains("subtopic_ids", json.dumps([sid])).execute().data:
                    if t["id"] not in known and t["id"] not in ids and t["id"] not in candidates:
                        candidates.append(t["id"])
            if len(candidates) >= n:
                break
        random.shuffle(candidates)
        add = candidates[:n - len(ids)]
        new_count = len(add)
        ids += add
    terms = rows_by_ids("terms", ids)
    for t in terms:
        t["box"] = boxes.get(t["id"], 0)
    random.shuffle(terms)
    return {"terms": terms, "due_count": len(due), "new_count": new_count}


# ---------- stats ----------

@app.get("/api/stats")
def stats(user: str = Query(...)):
    prog = fetch_all("progress", "question_id,seen,wrong,box", user_id=user)
    tprog = fetch_all("term_progress", "term_id,box", user_id=user)
    sp = stop_progress(user)
    base = {"trap_words": [], "topics": [], "exams": [],
            "totals": {"seen": 0, "wrong": 0, "questions": 0, "known": 0,
                       "words_known": sum(1 for t in tprog if t["box"] >= 2), "words_seen": len(tprog),
                       "stops_passed": sum(1 for p in sp.values() if p.get("quiz_passed")),
                       "topics_mastered": len(mastered_topics(user))}}
    if not prog:
        return base
    qmeta = {q["id"]: q for q in rows_by_ids("questions", [p["question_id"] for p in prog], select="id,topic_id,trap_words")}
    ts = {t["id"]: t for t in sb.table("topics").select("id,ord,title_en").execute().data}
    words_, per_topic = {}, {}
    for p in prog:
        q = qmeta.get(p["question_id"])
        if not q:
            continue
        for w in q["trap_words"]:
            w = w.lower()
            d = words_.setdefault(w, {"word": w, "wrong": 0, "seen": 0})
            d["wrong"] += p["wrong"]
            d["seen"] += p["seen"]
        t = per_topic.setdefault(q["topic_id"], {"id": q["topic_id"], "title_en": ts[q["topic_id"]]["title_en"],
                                                 "ord": ts[q["topic_id"]]["ord"], "seen": 0, "wrong": 0, "questions": 0, "known": 0})
        t["seen"] += p["seen"]
        t["wrong"] += p["wrong"]
        t["questions"] += 1
        t["known"] += 1 if p["box"] >= 2 else 0
    trap = sorted((w for w in words_.values() if w["wrong"] > 0), key=lambda w: (-w["wrong"], w["word"]))[:12]
    topics_out = sorted(per_topic.values(), key=lambda t: t["ord"])
    for t in topics_out:
        t["accuracy"] = round(100 * (t["seen"] - t["wrong"]) / t["seen"]) if t["seen"] else None
    exams = sb.table("sessions").select("finished_at,correct,total,passed").eq("user_id", user) \
        .eq("kind", "exam").order("finished_at", desc=True).limit(10).execute().data
    base["trap_words"] = trap
    base["topics"] = topics_out
    base["exams"] = exams
    base["totals"].update({"seen": sum(p["seen"] for p in prog), "wrong": sum(p["wrong"] for p in prog),
                           "questions": len(prog), "known": sum(1 for p in prog if p["box"] >= 2)})
    return base


# ---------- tutor ----------

TUTOR_SYSTEM = """You are a patient tutor for the Italian driving-theory exam (patente B), explaining to an English speaker
who lives in Italy. You get a quiz statement in Italian, its translation, the official answer and the learner's wrong answer.
In under 110 words of plain English: say what the statement is really claiming, name the exact Italian word or phrase that
decides it (quote it), state the rule, and give one memorable way to spot this trick next time. No headings, no bullet points."""


@app.post("/api/tutor")
def tutor(t: TutorAsk):
    if not ANTHROPIC_KEY:
        raise HTTPException(503, "Ask tutor is off: add ANTHROPIC_API_KEY to enable it.")
    cached = sb.table("tutor_cache").select("answer_en").eq("question_id", t.question_id).eq("user_answer", t.user_answer).execute().data
    if cached:
        return {"answer_en": cached[0]["answer_en"], "cached": True}
    q = sb.table("questions").select("*").eq("id", t.question_id).execute().data
    if not q:
        raise HTTPException(404, "question not found")
    q = q[0]
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    user_msg = (f"Italian statement: {q['q_it']}\nEnglish: {q.get('q_en') or '(none)'}\n"
                f"Official answer: {'Vero' if q['answer'] else 'Falso'}\nLearner answered: {'Vero' if t.user_answer else 'Falso'}\n"
                f"Trap words: {', '.join(q.get('trap_words') or []) or 'none'}\nNote: {q.get('why_en') or ''}")
    msg = client.messages.create(model=CLAUDE_MODEL, max_tokens=400, system=TUTOR_SYSTEM,
                                 messages=[{"role": "user", "content": user_msg}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    sb.table("tutor_cache").upsert({"question_id": t.question_id, "user_answer": t.user_answer, "answer_en": text}).execute()
    return {"answer_en": text, "cached": False}


# ---------- static PWA ----------

@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=str(WEB)), name="web")
