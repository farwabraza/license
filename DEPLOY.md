# STRADA v2 — setup guide (computer)

Follow top to bottom. Commands run in **Terminal** on the Mac. On Windows use PowerShell; the only
differences are noted inline. About 2 hours total, most of it the content pipeline running by itself.

## 0. What you need

- Python 3.11+ (`python3 --version`; on Windows `python --version`)
- Git (`git --version`; if missing: Mac → `xcode-select --install`, Windows → git-scm.com)
- A GitHub account (you have `farwabraza/license`)
- A Supabase account (free) — supabase.com
- An Anthropic API key — console.anthropic.com → API keys. Separate from Claude Max, billed by usage.
  Add ~€25 credit: the one-time enrichment is ~€15–20 on Sonnet (~€5 if you set
  `CLAUDE_MODEL=claude-haiku-4-5-20251001`); "Ask tutor" later costs a fraction of a cent per question.
- Render account (free) for hosting — render.com

## 1. Put v2 into your repo

Your repo currently has v1 without the dotfiles. Replace it with v2:

```bash
cd ~/Desktop                                    # or wherever you keep code
git clone https://github.com/farwabraza/license.git
cd license
```
Unzip `strada.zip` somewhere, then copy **everything inside the `strada` folder** (including the hidden
files `.gitignore`, `.replit`, `.env.example`) into `license`, replacing what's there. On Mac, in Finder press
⌘⇧. to show hidden files before dragging. Then:

```bash
git add -A
git commit -m "STRADA v2"
git push
```
Check on github.com that `.gitignore` now appears in the file list. That's the file that keeps your keys and
the generated audio out of the repo.

## 2. Supabase

1. supabase.com → **New project**. Name `strada`, region **Frankfurt**, generate a DB password (save it, you
   won't need it for this app). Wait ~2 minutes.
2. **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` → **Run**. Expect
   "Success. No rows returned".
3. **Project Settings → API**: copy the **Project URL** and the **service_role** secret key (click Reveal).

## 3. Keys on your machine

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
open -e .env                     # Windows: notepad .env
```
Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`. Save.

## 4. Your source material (before building anything)

Create `data/sources/` inside the repo folder and put in it:
- the two manuals (`.epub` files) — the 2026 Moretti manual is the important one, the illustrated course is a bonus
- the official listato: download https://www.neca.it/assets/pdf/ListatoAB.pdf and save it there as `ListatoAB.pdf`

```bash
mkdir -p data/sources
# copy the .epub files and ListatoAB.pdf into data/sources (Finder is fine)
python pipeline/00_sources.py
```
Expect two "sections … words" lines for the manuals and a table with ~30 sections and roughly 7,000 questions
for the listato. If the listato total is far off, run `python pipeline/00_sources.py --dump` and send me
`data/listato_raw.txt` — the PDF text layout may differ from what I tested on.

What this changes: step 01 builds the bank from the Feb-2025 official listato (post-reform) instead of the 2023
copy, inheriting the figures from the 2023 set; step 02 hands Claude the matching manual pages for every stop so
the lessons are grounded in the book. Nothing in `data/` is ever committed.

## 5. Build the content (once)

Every script is resumable — if it stops, run the same command again.

```bash
python pipeline/01_fetch_bank.py
```
Expect `Listato bank: 30 topics, … stops, … questions` (or the 2023 numbers if you skipped the listato).

Test the enrichment on one topic before paying for all of it:
```bash
python pipeline/02_enrich.py t01
```
Open `data/enriched/t01-s001.json`. Read the narration, the terms and a couple of question translations.
If it's good:
```bash
python pipeline/02_enrich.py          # 30–60 min, ~€15–20
```

Test the voice on one topic:
```bash
python pipeline/03_audio.py t01
open data/audio/t01-s001.mp3          # Windows: start data\audio\t01-s001.mp3
```
Don't like it? `python pipeline/03_audio.py --voices` lists alternatives; set `TTS_VOICE` in `.env`, delete
`data/audio/*.mp3`, re-run. Then:
```bash
python pipeline/03_audio.py           # 10–20 min, free
python pipeline/04_upload.py          # 5 min
```
Check in Supabase → Table Editor: `questions` 7,139 rows, `terms` a few hundred rows, Storage bucket `media`
with `images/` and `audio/`.

## 6. Try it locally

```bash
uvicorn server.main:app --reload --port 8000
```
Open http://localhost:8000. Enter your name. Walk one stop end to end:

1. **Road** → topic 1 → stop 1 (others show 🔒).
2. **Teach**: press play, tap a blue word, tap a word in the list. Press *Continue to Review*.
3. **Review**: word → meaning, meaning → word, and "which word completes the statement". Get one wrong on
   purpose: it comes back three cards later and has to be right twice.
4. **Quiz**: the stop's official questions. Get one wrong on purpose. At the end: *Not yet* if you're under
   90% first-try, with the missed list, *Repair* and *Retake*. Retake, pass, and stop 2 unlocks.
5. Back on the topic screen: *Topic test* and *Listen to all stops*. On the road: *Repair test* (needs some
   history first). Tabs: *Words* (flashcards), *Review* (spaced), *Exam*, *Stats* (also has the
   "unlock every stop" switch).

Ctrl+C stops the server.

## 7. Host it on Render (free)

1. `git push` anything you changed (nothing under `data/` or `.env` goes up — that's correct).
2. render.com → **New → Web Service** → connect GitHub → pick `farwabraza/license`.
3. Runtime **Python 3**. Build command `pip install -r requirements.txt`.
   Start command `uvicorn server.main:app --host 0.0.0.0 --port $PORT`.
4. **Environment** → add `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.
5. Instance type **Free** → **Deploy**. You get `https://<name>.onrender.com`.

Free tier sleeps after 15 min idle; the first request after that takes ~30 s. Lessons you've opened and the
app shell work offline.

(Replit alternative: Import from GitHub, add the same four Secrets, press Run. A permanent URL there needs
a paid deployment, which is why Render is the default here.)

## 7. Phone

Open the Render URL in Safari → Share → **Add to Home Screen**. Enter your name once. Mo can use the same URL
with his own name; progress is per name.

## Things that will bite you

- **Supabase free tier pauses after 7 idle days.** App shows "Couldn't load". Supabase dashboard → project →
  **Restore**, one minute.
- **A narration or explanation is wrong.** Edit the row in Supabase Table Editor (`subtopics.narration`,
  `questions.why_en`). For the audio: fix `data/enriched/<id>.json`, delete `data/audio/<id>.mp3`, then
  `02_enrich.py --merge`, `03_audio.py`, `04_upload.py`.
- **⚠ reform flag.** Questions in alcohol/drugs, phone-use and licence-points carry a warning: the bank is the
  2023 listato and the Dec 2024 reform touched those. Check them against a current source before the exam.
- **Pass rules** are env vars: `STOP_PASS_PCT` (90), `TOPIC_TEST_SIZE` (10), `TOPIC_TEST_MAX_ERRORS` (3),
  `EXAM_SIZE`/`EXAM_MINUTES`/`EXAM_MAX_ERRORS` (30/20/3).
- **Two people editing the repo** (you + an agent): commit before you let anything else touch it.
