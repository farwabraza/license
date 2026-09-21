# STRADA v2 — setup guide (Windows, PowerShell)

Every command below is for **PowerShell** (search "PowerShell" in the Start menu, open it normally — not as admin).
Where the Mac guide says `python3`, Windows says `python`. Where it says `source .venv/bin/activate`, Windows says
`.venv\Scripts\Activate.ps1`.

## 0. What you need

Check each one in PowerShell:
```powershell
python --version      # want 3.11 or newer. If it opens the Microsoft Store instead: install from python.org,
                      # and TICK "Add python.exe to PATH" in the installer. Then close and reopen PowerShell.
git --version         # if missing: git-scm.com → download → install with defaults → reopen PowerShell
```
Accounts: GitHub (you have it), Supabase (free), Anthropic API key with ~€25 credit (console.anthropic.com),
Render (free).

## 1. Put v2 into your repo

```powershell
cd $HOME\Desktop
git clone https://github.com/farwabraza/license.git
cd license
```
Now unzip `strada.zip` (right-click → Extract All). Open the extracted `strada` folder, select **everything**
inside it (Ctrl+A — the files starting with a dot are visible on Windows, no special step), copy, and paste into
`Desktop\license`, choosing **Replace** when asked. Then:

```powershell
git add -A
git commit -m "STRADA v2"
git push
```
If git asks who you are the first time:
```powershell
git config --global user.email "you@example.com"
git config --global user.name "Farwa"
```
If `git push` opens a browser window, sign in to GitHub there. Check github.com/farwabraza/license shows `.gitignore`.

## 2. Supabase

Same as the Mac guide: supabase.com → New project (Frankfurt) → SQL Editor → paste all of `supabase\schema.sql`
→ Run → Project Settings → API → copy Project URL and the service_role key.

## 3. Keys on your machine

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned    # once; answer Y. Lets the next line run.
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
```
Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`. Save (Ctrl+S) and close Notepad.
Your prompt should start with `(.venv)` — that means the virtual environment is active. Every new PowerShell
window needs `.venv\Scripts\Activate.ps1` again before running anything below.

## 4. Your source material (before building anything)

Create the folder `data\sources` inside the `license` folder (Explorer is fine) and put in it:
- the two manuals (`.epub` files) — the 2026 Moretti manual is the important one, the illustrated course is a bonus
- the official listato: open https://www.neca.it/assets/pdf/ListatoAB.pdf in the browser, save it into `data\sources`
  as `ListatoAB.pdf`

```powershell
python pipeline\00_sources.py
```
Expect two "sections … words" lines for the manuals and a table ending in `Listato: 31 sections, 716 blocks, 7144 questions` with no ⚠ lines
for the listato. If the total is far off, run `python pipeline\00_sources.py --dump` and send me
`data\listato_raw.txt`.

## 5. Build the content (once)

```powershell
python pipeline\01_fetch_bank.py
```
Expect `Listato bank: 31 topics, 716 stops, 7144 questions`.

Test one topic before paying for all of it:
```powershell
python pipeline\02_enrich.py t01
notepad data\enriched\t01-s001.json
```
Read the narration, terms and a couple of translations. If good:
```powershell
python pipeline\02_enrich.py          # 30–60 min, ~€15–20. Leave the window open.
```

Test the voice:
```powershell
python pipeline\03_audio.py t01
start data\audio\t01-s001.mp3
```
Don't like it? `python pipeline\03_audio.py --voices` lists alternatives; set `TTS_VOICE` in `.env`,
`Remove-Item data\audio\*.mp3`, re-run. Then:
```powershell
python pipeline\03_audio.py           # 10–20 min, free
python pipeline\04_upload.py          # 5 min
```

## 6. Try it locally

```powershell
uvicorn server.main:app --reload --port 8000
```
Open http://localhost:8000 in Chrome or Edge. Walk stop 1 through Teach → Review → Quiz (fail the quiz once on
purpose to see Repair and Retake). Ctrl+C in PowerShell stops the server.

## 7–8. Render and phone

Identical to the Mac guide (DEPLOY.md sections 7 and 9) — it's all in the browser.

## Windows-specific things that bite

- **"python is not recognized"** → Python not on PATH. Reinstall from python.org with "Add to PATH" ticked,
  reopen PowerShell.
- **"running scripts is disabled on this system"** → you skipped the `Set-ExecutionPolicy` line in step 3.
- **"No module named fastapi/anthropic/…"** → the venv isn't active in this window. Run `.venv\Scripts\Activate.ps1`.
- **Notepad saved `.env.txt`** → you created the file from scratch instead of copying `.env.example`. In PowerShell:
  `Rename-Item .env.txt .env`.
- **Accented characters look wrong in PowerShell output** → cosmetic only; the files are fine. `chcp 65001` fixes the display.
