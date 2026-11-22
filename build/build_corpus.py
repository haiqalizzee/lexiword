#!/usr/bin/env python3
"""
LexiFind corpus builder.

Pipeline
  1. Base word list: ENABLE (enable1.txt, public-domain Scrabble-era list).
     Only lowercase a–z entries, length >= 2.
  2. Commonness: wordfreq (Zipf scale, 1-8) for English.
  3. Proper nouns: WordNet "instance" synsets are proper nouns. An entry that
     is only a proper noun in WordNet is dropped, unless it is a given name
     (handled by the Names toggle).
  4. Scientific-jargon filter (see JARGON_ROOTS): rare-to-mid words (Zipf < 3.5)
     whose every common WordNet sense lives under a technical taxonomy node
     (chemical elements, compounds, minerals, enzymes, celestial bodies,
     taxonomic groups) are removed.
  5. Definitions (2 senses max, WordNet) + POS codes. Inflected forms without
     their own entry get "Inflected form of <base>".
  6. Roman numerals I..MMMCMXCIX are generated (3,999). Numerals that already
     exist as dictionary words are flagged, not duplicated.
  7. Given names from a 690-name first-name list are flagged; name-only
     entries (no common-noun sense) are marked so the UI can hide them.

Outputs (in ../public/data)
  words.txt         word \t z10 \t flags \t pos \t numeric-value
  defs/<letter>.txt word \t sense1 \t sense2   (lazy-loaded per letter)
  stats.json        counts for the UI and the README
"""
import json, os, re, sys, collections
import wordfreq
from nltk.corpus import wordnet as wn
from faker.providers.person.en_US import Provider as NamesProvider

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "enable1.txt")
OUT = os.path.join(HERE, "..", "public", "data")
os.makedirs(os.path.join(OUT, "defs"), exist_ok=True)

# Flag bits
F_NAME_ONLY = 1     # given name with no common-noun sense -> hidden by Names toggle off
F_ROMAN = 2         # Roman numeral (value in col 5)
F_ROMAN_ONLY = 4    # Roman numeral that is NOT a dictionary word -> hidden by Roman toggle off
F_INFLECTED = 8     # inflected form (definition points to base)
F_NAME = 16         # given name (badge)

JARGON_ROOTS = {
    "chemical_element.n.01", "compound.n.02", "mineral.n.01", "enzyme.n.01",
    "celestial_body.n.01", "taxonomic_group.n.01", "genus.n.02",
    "alkaloid.n.01", "steroid.n.01", "isotope.n.01", "radical.n.03",
    "hydrocarbon.n.01", "salt.n.02", "polymer.n.01", "crystal.n.01",
}
_anc_cache = {}
def ancestors(s):
    if s in _anc_cache:
        return _anc_cache[s]
    seen, stack = set(), [s]
    while stack:
        x = stack.pop()
        for h in x.hypernyms() + x.instance_hypernyms():
            if h.name() not in seen:
                seen.add(h.name()); stack.append(h)
    _anc_cache[s] = seen
    return seen

def is_jargon_sense(s):
    return bool(ancestors(s) & JARGON_ROOTS)

POS_CODE = {"n": "n", "v": "v", "a": "adj", "s": "adj", "r": "adv"}

def gloss_short(g, limit=120):
    g = g.strip()
    # first clause only; WordNet glosses are "a; b; c" style
    g = g.split(";")[0].strip()
    if len(g) > limit:
        g = g[: limit - 1].rsplit(" ", 1)[0] + "…"
    return g[:1].upper() + g[1:] if g else g

def roman(n):
    vals = [(1000,"M"),(900,"CM"),(500,"D"),(400,"CD"),(100,"C"),(90,"XC"),
            (50,"L"),(40,"XL"),(10,"X"),(9,"IX"),(5,"V"),(4,"IV"),(1,"I")]
    out = []
    for v, s in vals:
        while n >= v:
            out.append(s); n -= v
    return "".join(out)

def main():
    raw = [w.strip() for w in open(SRC, encoding="utf-8") if w.strip()]
    base = sorted({w for w in raw if re.fullmatch(r"[a-z]{2,}", w)})
    base_set = set(base)
    given = {n.lower() for n in NamesProvider.first_names if re.fullmatch(r"[A-Za-z]{2,}", n)}

    stats = collections.Counter()
    stats["enable_entries_lowercase_2plus"] = len(base)
    entries = []   # (word, z10, flags, pos, value, defs)

    for w in base:
        z = wordfreq.zipf_frequency(w, "en")
        z10 = int(round(z * 10))
        syns = wn.synsets(w)
        common = [s for s in syns if not s.instance_hypernyms()
                  and any(l.name().lower() == w for l in s.lemmas())]
        proper_only = bool(syns) and not common

        flags = 0
        if w in given:
            flags |= F_NAME
            if not common:
                flags |= F_NAME_ONLY

        # proper-noun-only entries that are not given names -> not playable
        if proper_only and w not in given:
            stats["dropped_proper_noun"] += 1
            continue

        # scientific / technical jargon
        if common and z < 3.5 and all(is_jargon_sense(s) for s in common):
            stats["dropped_scientific_jargon"] += 1
            continue

        defs, pos = [], set()
        if common:
            for s in common:
                pos.add(POS_CODE.get(s.pos(), s.pos()))
            for s in common[:2]:
                defs.append(f"{POS_CODE.get(s.pos(), s.pos())}: {gloss_short(s.definition())}")
        else:
            base_word = None
            m = wn.morphy(w)
            if m and m != w and m in base_set:
                base_word = m
            elif m and m != w:
                base_word = m
            if base_word:
                flags |= F_INFLECTED
                defs.append(f"Inflected form of “{base_word}”.")
                bsyn = [s for s in wn.synsets(base_word)]
                if bsyn:
                    for p in {POS_CODE.get(s.pos(), s.pos()) for s in bsyn[:3]}:
                        pos.add(p)
                stats["inflected_forms"] += 1
            else:
                stats["no_wordnet_entry"] += 1

        entries.append([w, z10, flags, "|".join(sorted(pos)), "", defs])

    # Roman numerals
    have = {e[0]: e for e in entries}
    for n in range(1, 4000):
        r = roman(n).lower()
        if r in have:
            e = have[r]
            e[2] |= F_ROMAN
            e[4] = str(n)
            e[5] = [f"Roman numeral for {n}."] + e[5][:1]
            e[3] = e[3] or "num"
            stats["roman_also_dictionary_word"] += 1
        else:
            z10 = int(round(wordfreq.zipf_frequency(r, "en") * 10))
            entries.append([r, z10, F_ROMAN | F_ROMAN_ONLY, "num", str(n),
                            [f"Roman numeral for {n}."]])
            stats["roman_numerals_added"] += 1

    entries.sort(key=lambda e: e[0])

    # write the corpus as two alphabetical halves (hosts cap files at 2 MiB)
    halves = {"words-1.txt": [], "words-2.txt": []}
    for w, z10, flags, pos, val, _ in entries:
        key = "words-1.txt" if w[0] <= "m" else "words-2.txt"
        halves[key].append(f"{w}\t{z10}\t{flags}\t{pos}\t{val}")
    for name, lines in halves.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        stats.setdefault("corpus_parts", {})[name] = len(lines)

    # write per-letter definitions
    by_letter = collections.defaultdict(list)
    for w, _, _, _, _, defs in entries:
        if defs and w[0].isalpha():
            by_letter[w[0]].append(f"{w}\t" + "\t".join(d.replace("\t", " ").replace("\n", " ") for d in defs))
    for letter, lines in by_letter.items():
        with open(os.path.join(OUT, "defs", f"{letter}.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    total = len(entries)
    stats["playable_entries"] = total
    stats["with_definition"] = sum(1 for e in entries if e[5])
    stats["name_flagged"] = sum(1 for e in entries if e[2] & F_NAME)
    stats["name_only"] = sum(1 for e in entries if e[2] & F_NAME_ONLY)
    stats["roman_only"] = sum(1 for e in entries if e[2] & F_ROMAN_ONLY)
    json.dump(dict(stats), open(os.path.join(OUT, "stats.json"), "w"), indent=2)
    print(json.dumps(dict(stats), indent=2))

if __name__ == "__main__":
    main()
