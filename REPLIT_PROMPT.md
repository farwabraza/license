# Using Replit Agent with this repo

Short version: don't ask Replit Agent to build this from scratch. The hard part isn't the app, it's the one-time
content pipeline — Claude enrichment you should eyeball before spending on all 656 sub-topics, a voice you should
listen to before generating 656 clips, and secrets that shouldn't be pasted into an agent chat. Run the pipeline
on your Mac as DEPLOY.md describes; that's four commands.

Where Agent is useful: after you import the repo, for changes and fixes. Paste this as your first message so it
understands the codebase and doesn't reinvent it:

---

This repo is STRADA, a personal study app for the Italian driving-theory exam. Read README.md and DEPLOY.md first.

Architecture, do not change it:
- `server/main.py` is a FastAPI app. It serves `web/` as static files and exposes `/api/*` routes that read and
  write Supabase through the service key from the environment (SUPABASE_URL, SUPABASE_SERVICE_KEY). There is no
  auth; the user is identified by a name string the front end sends.
- `web/app.js` is a single-file vanilla JS PWA with a hash router. Screens: road, topic, lesson (Teach),
  review-stage, quiz (with the pass-to-unlock gate), topic-test, repair, review, words, exam, stats. `web/styles.css` holds the design tokens. No build step, no framework.
- Content (questions, lessons, audio) is produced by the scripts in `pipeline/` and lives in Supabase. Never
  regenerate content from the app.
- Secrets come from Replit Secrets. Never hardcode keys.

Run command is in `.replit`. Start by running the app and confirming `/api/health` returns `{"ok": true}`.

Then wait for my instructions. When I ask for a change, make the smallest change that does it, keep the visual
language (road-sign blue, yellow trap-word highlights, Overpass typeface), and don't add dependencies without asking.

---

Good tasks to hand it later: keyboard shortcuts on desktop (V/F keys), an Italian-only mode that hides
translations, a daily streak counter, per-topic YouTube links.
