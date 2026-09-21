"""Shared paths, env loading and the 25-topic map used by every pipeline step."""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DATA = ROOT / "data"
IMAGES = DATA / "images"
AUDIO = DATA / "audio"
ENRICHED = DATA / "enriched"
BANK = DATA / "bank.json"          # normalised question bank (output of step 01)
FINAL = DATA / "final.json"        # bank + enrichment merged (output of step 02)

for p in (DATA, IMAGES, AUDIO, ENRICHED):
    p.mkdir(parents=True, exist_ok=True)

SOURCE_REPO = "https://raw.githubusercontent.com/Ed0ardo/QuizPatenteB/main"

# Ministry topic order as it appears in the source JSON.
TOPICS = [
    ("definizioni-generali-doveri-strada", "Definizioni generali e doveri", "Definitions & duties on the road"),
    ("segnali-pericolo", "Segnali di pericolo", "Warning signs"),
    ("segnali-divieto", "Segnali di divieto", "Prohibition signs"),
    ("segnali-obbligo", "Segnali di obbligo", "Mandatory signs"),
    ("segnali-precedenza", "Segnali di precedenza", "Right-of-way signs"),
    ("segnaletica-orizzontale-ostacoli", "Segnaletica orizzontale e ostacoli", "Road markings & obstacles"),
    ("semafori-vigili", "Semafori e vigili", "Traffic lights & police signals"),
    ("segnali-indicazione", "Segnali di indicazione", "Information signs"),
    ("segnali-complementari-cantiere", "Segnali complementari e di cantiere", "Supplementary & roadwork signs"),
    ("pannelli-integrativi", "Pannelli integrativi", "Supplementary panels"),
    ("limiti-di-velocita", "Limiti di velocità", "Speed limits"),
    ("distanza-di-sicurezza", "Distanza di sicurezza", "Safe following distance"),
    ("norme-di-circolazione", "Norme di circolazione", "Traffic rules"),
    ("precedenza-incroci", "Precedenza agli incroci", "Right of way at intersections"),
    ("sorpasso", "Sorpasso", "Overtaking"),
    ("fermata-sosta-arresto", "Fermata, sosta e arresto", "Stopping, parking & halting"),
    ("norme-varie-autostrade-pannelli", "Autostrade e norme varie", "Motorways & other rules"),
    ("luci-dispositivi-acustici", "Luci e dispositivi acustici", "Lights & horn"),
    ("cinture-casco-sicurezza", "Cinture, casco e sicurezza", "Seat belts, helmets & safety"),
    ("patente-punti-documenti", "Patente, punti e documenti", "Licence, points & documents"),
    ("incidenti-stradali-comportamenti", "Incidenti stradali", "Accidents: what to do"),
    ("alcool-droga-primo-soccorso", "Alcool, droga e primo soccorso", "Alcohol, drugs & first aid"),
    ("responsabilita-civile-penale-e-assicurazione", "Responsabilità e assicurazione", "Liability & insurance"),
    ("consumi-ambiente-inquinamento", "Consumi, ambiente e inquinamento", "Fuel, environment & pollution"),
    ("elementi-veicolo-manutenzione-comportamenti", "Elementi del veicolo e manutenzione", "Vehicle parts & maintenance"),
]

# Topics where the Dec 2024 Codice reform changed rules; enrichment asks Claude to flag questions here.
REFORM_TOPICS = {
    "alcool-droga-primo-soccorso", "patente-punti-documenti", "norme-di-circolazione", "cinture-casco-sicurezza",   # 2023 bank slugs
    "documenti", "cause-incidenti", "cinture-airbag-casco", "primo-soccorso", "posizione-cambio-corsia",             # listato slugs
}
MANUAL = DATA / "manual_sections.json"   # output of 00_sources.py (optional)


def env(name: str, default: str | None = None) -> str:
    v = os.getenv(name, default)
    if v is None or v == "":
        raise SystemExit(f"Missing environment variable {name}. Copy .env.example to .env and fill it in.")
    return v


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def slug_to_title(slug: str) -> str:
    return slug.replace("-", " ").capitalize()


def term_key(it: str) -> str:
    """Normalised identity for an Italian term: lowercase, accents kept, punctuation stripped."""
    import re
    it = it.strip().lower()
    it = re.sub(r"[^\w\s'-]", "", it)
    it = re.sub(r"\s+", " ", it)
    return it


def term_id(it: str) -> str:
    import re
    import unicodedata
    ascii_ = unicodedata.normalize("NFKD", term_key(it)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_.replace("'", " ")).strip("-")[:60] or "term"
