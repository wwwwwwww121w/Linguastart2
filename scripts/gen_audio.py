#!/usr/bin/env python3
"""Generate offline TTS audio (MP3) for every quiz word.

Reads LinguaStart_v3.html, finds all QUIZ words for `en` and `ar` blocks,
and generates an MP3 per (word, voice) combination using gTTS.

Output:
  audio/<voice_id>/<hash>.mp3
  audio/manifest.json  -- {"voices":{...}, "words":{lang:{word:hash}}}

Voices:
  en_us  -> en, tld=com   (American)
  en_uk  -> en, tld=co.uk (British)
  en_au  -> en, tld=com.au (Australian)
  ar_std -> ar, tld=com   (Modern Standard)
"""
from __future__ import annotations
import hashlib, json, os, re, sys, time
from pathlib import Path
from gtts import gTTS

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "LinguaStart_v3.html"
OUT  = ROOT / "audio"
OUT.mkdir(exist_ok=True)

VOICES = {
    "en_us": {"lang": "en", "tld": "com",     "label": "Английский (США) — женский"},
    "en_uk": {"lang": "en", "tld": "co.uk",   "label": "Английский (UK) — женский"},
    "en_au": {"lang": "en", "tld": "com.au",  "label": "Английский (AU) — женский"},
    "ar_std":{"lang": "ar", "tld": "com",     "label": "Арабский (стандарт)"},
}

def extract_words(html: str):
    """Return {'en': set(words), 'ar': set(words)} from QUIZ data."""
    out = {"en": set(), "ar": set()}
    # Find the QUIZ={ en:{...}, ar:{...} } object body
    m = re.search(r"const QUIZ\s*=\s*\{(.*?)\};\s*\n", html, re.DOTALL)
    if not m:
        sys.exit("QUIZ block not found")
    body = m.group(1)
    # Split by top-level keys en:{ ... }, ar:{ ... }
    # crude balanced-brace split by depth
    def slice_block(text, key):
        # Find `key:{` (top-level language key), not nested `ar:1` flags.
        m2 = re.search(r"(?:^|[\s\{,])" + re.escape(key) + r"\s*:\s*\{", text)
        if not m2: return ""
        b = text.find("{", m2.start())
        depth = 0
        for j in range(b, len(text)):
            if text[j] == "{": depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    return text[b+1:j]
        return ""
    en_block = slice_block(body, "en")
    ar_block = slice_block(body, "ar")
    # Extract w:'...' or w:"..."
    word_pat = re.compile(r"w\s*:\s*(?:'((?:\\'|[^'])*)'|\"((?:\\\"|[^\"])*)\")")
    for blk, lang in ((en_block, "en"), (ar_block, "ar")):
        for m in word_pat.finditer(blk):
            w = (m.group(1) or m.group(2)).replace("\\'", "'").replace('\\"', '"').strip()
            if w:
                out[lang].add(w)
    return out

def word_hash(word: str, voice: str) -> str:
    return hashlib.md5(f"{voice}|{word}".encode("utf-8")).hexdigest()[:16]

def synth(word: str, voice_id: str) -> str:
    cfg = VOICES[voice_id]
    h = word_hash(word, voice_id)
    target_dir = OUT / voice_id
    target_dir.mkdir(exist_ok=True)
    target = target_dir / f"{h}.mp3"
    if target.exists() and target.stat().st_size > 200:
        return h
    last_err = None
    for attempt in range(3):
        try:
            t = gTTS(text=word, lang=cfg["lang"], tld=cfg["tld"], slow=False)
            tmp = target.with_suffix(".tmp")
            t.save(str(tmp))
            tmp.rename(target)
            return h
        except Exception as e:
            last_err = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"failed to synthesize {word!r} for {voice_id}: {last_err}")

def main():
    html = HTML.read_text(encoding="utf-8")
    words = extract_words(html)
    print(f"EN words: {len(words['en'])}")
    print(f"AR words: {len(words['ar'])}")

    manifest = {
        "voices": {k: v["label"] for k, v in VOICES.items()},
        "lang_voices": {
            "en": ["en_us", "en_uk", "en_au"],
            "ar": ["ar_std"],
        },
        "words": {"en": {}, "ar": {}},
    }

    for voice_id, cfg in VOICES.items():
        lang = cfg["lang"]
        wlist = sorted(words[lang])
        print(f"\n[{voice_id}] generating {len(wlist)} files...")
        for i, w in enumerate(wlist, 1):
            try:
                h = synth(w, voice_id)
                manifest["words"][lang].setdefault(w, {})[voice_id] = h
                if i % 20 == 0 or i == len(wlist):
                    print(f"  {i}/{len(wlist)}")
            except Exception as e:
                print(f"  ! {w}: {e}")

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nDone. Manifest written.")

if __name__ == "__main__":
    main()
