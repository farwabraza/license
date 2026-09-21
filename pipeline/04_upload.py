"""Step 04 — upload images + audio to Supabase Storage and upsert topics/subtopics/questions into the tables.

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env and supabase/schema.sql already run.
Run:  python pipeline/04_upload.py
      python pipeline/04_upload.py --skip-media    # only refresh the table rows
Safe to re-run: storage uploads use upsert, rows are upserted by id.
"""
import mimetypes
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from supabase import create_client

from common import AUDIO, FINAL, IMAGES, env, load_json, term_id, term_key

BUCKET = "media"


def ensure_bucket(sb):
    names = {b.name for b in sb.storage.list_buckets()}
    if BUCKET not in names:
        sb.storage.create_bucket(BUCKET, options={"public": True})
        print(f"Created public bucket '{BUCKET}'")


def upload_file(sb, local, remote, tries=5):
    """Upload one file; Storage sometimes drops the connection under load, so retry with backoff.
    Returns None on success, or the error text after the last try."""
    ctype = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
    data = local.read_bytes()
    for attempt in range(1, tries + 1):
        try:
            sb.storage.from_(BUCKET).upload(remote, data, file_options={"content-type": ctype, "upsert": "true"})
            return None
        except Exception as e:  # noqa: BLE001 — httpx protocol errors and Storage 5xx alike
            if attempt == tries:
                return f"{remote}: {str(e)[:120]}"
            time.sleep(2 ** attempt)


def public_url(sb, remote):
    return sb.storage.from_(BUCKET).get_public_url(remote)


def chunked(rows, n=400):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


def main():
    sb = create_client(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"))
    bank = load_json(FINAL)
    skip_media = "--skip-media" in sys.argv

    ensure_bucket(sb)

    if not skip_media:
        jobs = [(IMAGES / p.name, f"images/{p.name}") for p in sorted(IMAGES.glob("*.png"))]
        jobs += [(AUDIO / p.name, f"audio/{p.name}") for p in sorted(AUDIO.glob("*.mp3"))]
        print(f"Uploading {len(jobs)} media files…")
        done, failed = 0, []
        with ThreadPoolExecutor(max_workers=4) as pool:
            for err in pool.map(lambda j: upload_file(sb, *j), jobs):
                done += 1
                if err:
                    failed.append(err)
                if done % 100 == 0:
                    print(f"  {done}/{len(jobs)}")
        if failed:
            print(f"⚠ {len(failed)} media files failed after retries (re-run to try again): {failed[:5]}")
        else:
            print("Media uploaded.")

    audio_ids = {p.stem for p in AUDIO.glob("*.mp3")}

    topics = bank["topics"]
    subtopics = [{
        "id": s["id"], "topic_id": s["topic_id"], "ord": s["ord"], "slug": s["slug"],
        "title_it": s["title_it"], "title_en": s.get("title_en") or s["title_it"],
        "narration": s.get("narration"), "terms": s.get("terms") or [],
        "image_url": public_url(sb, f"images/{s['image']}") if s.get("image") else None,
        "audio_url": public_url(sb, f"audio/{s['id']}.mp3") if s["id"] in audio_ids else None,
        "question_count": s["question_count"],
    } for s in bank["subtopics"]]
    questions = [{
        "id": q["id"], "subtopic_id": q["subtopic_id"], "topic_id": q["topic_id"], "ord": q["ord"],
        "q_it": q["q_it"], "answer": q["answer"],
        "image_url": public_url(sb, f"images/{q['image']}") if q.get("image") else None,
        "q_en": q.get("q_en"), "trap_words": q.get("trap_words") or [], "trap_type": q.get("trap_type") or "none",
        "why_en": q.get("why_en"), "reform_check": bool(q.get("reform_check")),
    } for q in bank["questions"]]

    # one row per distinct Italian word across the course
    terms, seen = [], {}
    for s in bank["subtopics"]:
        for t in s.get("terms") or []:
            it = (t.get("it") or "").strip()
            if not it or not t.get("en"):
                continue
            k = term_key(it)
            if k in seen:
                if s["id"] not in seen[k]["subtopic_ids"]:
                    seen[k]["subtopic_ids"].append(s["id"])
                continue
            row = {"id": term_id(it), "it": it, "en": t["en"].strip(), "note": (t.get("note") or "").strip() or None,
                   "topic_id": s["topic_id"], "subtopic_ids": [s["id"]]}
            seen[k] = row
            terms.append(row)
    # guard against two different keys collapsing to the same id
    ids = {}
    for row in terms:
        base = row["id"]
        n = 2
        while row["id"] in ids:
            row["id"] = f"{base}-{n}"
            n += 1
        ids[row["id"]] = True

    print("Upserting rows…")
    sb.table("topics").upsert(topics).execute()
    for c in chunked(subtopics):
        sb.table("subtopics").upsert(c).execute()
    for i, c in enumerate(chunked(questions), 1):
        sb.table("questions").upsert(c).execute()
        print(f"  questions {min(i * 400, len(questions))}/{len(questions)}")
    for c in chunked(terms):
        sb.table("terms").upsert(c).execute()
    print(f"  terms {len(terms)}")
    print("Done. Open the app.")


if __name__ == "__main__":
    main()
