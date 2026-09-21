# STRADA — patente B, taught in English

A personal study app for the Italian driving-theory exam (quiz vero/falso, patente B), built on the
Driving Freedom loop — Teach → Review → Quiz per stop, pass to unlock the next — with no paywall.

Free to run: MIT-licensed question bank, narration generated once with free Microsoft neural voices,
questions read aloud by the phone's own Italian voice, and it fits inside Supabase's and Render's free tiers.
The only paid step is the one-time Claude pass that writes the lessons and translations (~€15–20).

## The loop

Course = the ministry listato's sections (≈30 topics) → its blocks (≈650 stops: one figure or concept each) → questions.

Each stop:
1. **Teach** — English narration with the Italian exam words called out (tap to hear them), the figure, a word list.
2. **Review** — three exercise types built from the stop's own content: *word → meaning*, *meaning → word*,
   *which word completes the official statement* (the trap word blanked out). Wrong answers come back three
   cards later and must be right twice. Every word has its own Leitner box.
3. **Quiz** — the stop's official questions, repeat-until-cleared. First-try accuracy ≥ 90% passes the stop and
   unlocks the next one. Below that: the missed list, a repair drill, retake.

Around the loop:
- **Topic test** — 10 official questions from a topic, ≤3 errors = mastered.
- **Repair test** — 10 questions from your two weakest topics, weighted to what you've missed.
- **Words** — flashcards for due and new exam words (Leitner: 0/1/3/7/14/30 days).
- **Review** — official questions due on the same schedule.
- **Exam** — 30 questions, 20 minutes, max 3 errors, no help.
- **Stats** — the trap words that keep catching you, accuracy per topic, exam history, and the
  "unlock every stop" switch.

## How it's built

```
pipeline/      run once on your computer → content ends up in Supabase
  00_sources.py      your .epub manuals → searchable sections; neca.it ListatoAB.pdf → the official question bank
  01_fetch_bank.py   builds the bank from the listato (Feb 2025) with figures from the open 2023 set (MIT)
  02_enrich.py       Claude, one call per stop, with the matching manual pages as source of truth:
                     narration, glossary, translations, trap words, why-V/F
  03_audio.py        edge-tts: one MP3 per stop, English voice that pronounces Italian correctly
  04_upload.py       tables + media to Supabase; builds the terms table from the glossaries
server/main.py       FastAPI: JSON API over Supabase, serves the PWA, proxies "Ask tutor" to Claude
web/                 vanilla-JS PWA, no build step
supabase/schema.sql  tables
```

**DEPLOY.md** is the step-by-step. **REPLIT_PROMPT.md** if you want an agent to help with changes.
