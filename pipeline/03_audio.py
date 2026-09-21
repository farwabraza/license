"""Step 03 — generate one MP3 per sub-topic narration with edge-tts (free Microsoft neural voices, no key).

Uses a multilingual English voice so Italian words inside English sentences are pronounced as Italian.
Output: data/audio/<subtopic_id>.mp3. Resumable.

Run:  python pipeline/03_audio.py
      python pipeline/03_audio.py t03           # only topic t03
      python pipeline/03_audio.py --voices      # list multilingual voices you could use instead
Voice is set by TTS_VOICE in .env (default en-US-AvaMultilingualNeural).
"""
import asyncio
import re
import sys

import edge_tts

from common import AUDIO, FINAL, env, load_json

VOICE = env("TTS_VOICE", "en-US-AvaMultilingualNeural")
RATE = env("TTS_RATE", "-4%")
CONCURRENCY = int(env("TTS_CONCURRENCY", "4"))


def narration_to_speech_text(narration: str) -> str:
    # [[carreggiata]] -> carreggiata, with a tiny pause after so the term stands out
    text = re.sub(r"\[\[(.+?)\]\]", r"\1,", narration)
    return re.sub(r"\s+", " ", text).strip()


async def synth(sem, sub, path):
    async with sem:
        for attempt in range(3):
            try:
                tts = edge_tts.Communicate(narration_to_speech_text(sub["narration"]), VOICE, rate=RATE)
                await tts.save(str(path))
                if path.stat().st_size > 1000:
                    return True
            except Exception as e:  # noqa: BLE001
                print(f"  retry {sub['id']} ({e})")
                await asyncio.sleep(2 * (attempt + 1))
        return False


async def list_voices():
    voices = await edge_tts.list_voices()
    for v in voices:
        if "Multilingual" in v["ShortName"]:
            print(v["ShortName"], "—", v["Gender"])


async def main():
    if "--voices" in sys.argv:
        await list_voices()
        return
    only_topic = next((a for a in sys.argv[1:] if a.startswith("t")), None)
    bank = load_json(FINAL)
    todo = [s for s in bank["subtopics"]
            if s.get("narration") and not (AUDIO / f"{s['id']}.mp3").exists()
            and (only_topic is None or s["topic_id"] == only_topic)]
    print(f"Voice {VOICE} · {len(todo)} clips to generate")
    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(synth(sem, s, AUDIO / f"{s['id']}.mp3") for s in todo))
    ok = sum(1 for r in results if r)
    print(f"{ok}/{len(todo)} generated → {AUDIO}")
    if ok < len(todo):
        print("Some clips failed — run again to retry the missing ones.")


if __name__ == "__main__":
    asyncio.run(main())
