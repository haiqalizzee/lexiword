# LexiFind

Playable word finder for Scrabble, Words With Friends and Wordle. Static site, no build step.

## Run
    python3 -m http.server 8080 --directory public
    open http://localhost:8080

## Rebuild the corpus
Requires `wordfreq`, `nltk` (WordNet + omw-1.4) and the ENABLE list in `data/enable1.txt`.

    python3 build/build_corpus.py

Outputs `public/data/words-1.txt` and `words-2.txt` (alphabetical halves, kept under the 2 MiB host file cap), `public/data/defs/<letter>.txt` and `public/data/stats.json`.

## Search
Three optional fields combine with AND: **Starts with**, **Contains**, **Ends with**.
Any subset works, e.g. `st` + `ing` finds `starting`, `standing`. A prefix also narrows the
alphabetical range by binary search, so adding an end condition costs nothing extra.
Length filters (exact or range) and the sort/limit controls apply on top.

## Corpus rules
- Base: ENABLE word list, lowercase, 2+ letters (172,823).
- Scientific jargon removed: rare words (Zipf < 3.5) whose every common WordNet sense falls under technical roots (element, mineral, enzyme, isotope, ...). Known false positives include `napalm`, `mutineer`, `tenderizer`.
- Proper nouns removed when WordNet knows the word only as a named entity (50,482).
- Given names (Faker list) are flagged; name-only entries are hidden unless "Playable human names" is on.
- Roman numerals 1–3999 are added as entries and hidden unless "Roman numerals" is on. Words that are both numerals and dictionary words (e.g. `mix`) stay visible.
- Known gap: ENABLE does not contain `qi`.

## Definitions
Offline WordNet 3.0 glosses cover ~57k entries. Other words get a "Look up definition" button that calls the Free Dictionary API on demand. Merriam-Webster links open in a new tab.

## Tests
    python3 test/e2e.py   # Playwright; needs a server on :8080
