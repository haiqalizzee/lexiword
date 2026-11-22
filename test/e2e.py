import json, os, sys
from playwright.sync_api import sync_playwright

URL = os.environ.get("APP_URL", "http://127.0.0.1:8080/")
DATA = os.environ.get("DATA_DIR", "/workspace/lexiword/public/data")
ROWS = []
for part in ("words-1.txt", "words-2.txt"):
    for line in open(os.path.join(DATA, part)):
        p = line.rstrip("\n").split("\t")
        if p[0]:
            ROWS.append((p[0], int(p[2] or 0)))

def expect(pre="", mid="", suf="", lo=None, hi=None, roman=False, names=False):
    n = 0
    for w, fl in ROWS:
        if (fl & 4) and not roman: continue
        if (fl & 1) and not names: continue
        if lo is not None and not (lo <= len(w) <= hi): continue
        if pre and not w.startswith(pre): continue
        if suf and not w.endswith(suf): continue
        if mid and mid not in w: continue
        n += 1
    return n

def parse_summary(s):
    return int(s.split()[0].replace(",", ""))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 950})
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_selector(".card", timeout=25000)
    out = {}

    def setf(pre="", mid="", suf="", lo=None, hi=None, roman=False, names=False):
        pg.fill("#q", ""); pg.fill("#qc", ""); pg.fill("#qs", "")
        if pre: pg.fill("#q", pre)
        if mid: pg.fill("#qc", mid)
        if suf: pg.fill("#qs", suf)
        if lo is None:
            pg.select_option("#lenMode", "any")
        elif lo == hi:
            pg.select_option("#lenMode", "exact"); pg.fill("#lenA", str(lo))
        else:
            pg.select_option("#lenMode", "range"); pg.fill("#lenA", str(lo)); pg.fill("#lenB", str(hi))
        for sel, want in (("#romanToggle", roman), ("#nameToggle", names)):
            on = pg.eval_on_selector(sel, "e => e.checked")
            if on != want: pg.click(f"label.toggle:has({sel})")
        pg.select_option("#limit", "0")
        pg.wait_for_timeout(340)
        return parse_summary(pg.inner_text("#summary")), \
               [t.strip().lower() for t in pg.locator(".card .word").all_inner_texts()]

    def check(name, pre="", mid="", suf="", **kw):
        got, words = setf(pre, mid, suf, **kw)
        want = expect(pre, mid, suf, **kw)
        ok = got == want
        # verify every rendered word really satisfies the pattern
        prop = all((not pre or w.startswith(pre)) and (not suf or w.endswith(suf)) and (not mid or mid in w) for w in words[:300])
        out[name] = {"got": got, "want": want, "count_ok": ok, "props_ok": prop, "n_words": len(words)}
        return ok and prop

    results = []
    results.append(check("prefix_only", pre="qu"))
    results.append(check("suffix_only", suf="ing"))
    results.append(check("contains_only", mid="ough"))
    # the new capability: both ends at once
    results.append(check("both_ends", pre="c", suf="e"))
    results.append(check("both_ends2", pre="st", suf="ing"))
    results.append(check("both_ends3", pre="ca", suf="er"))
    results.append(check("all_three", pre="s", mid="a", suf="e"))
    # combined with length + flags
    results.append(check("both_len4", pre="b", suf="e", lo=4, hi=4))
    results.append(check("both_len_range", pre="a", suf="y", lo=3, hi=5))
    results.append(check("roman_both", pre="x", suf="v", roman=True))
    results.append(check("names_both", pre="a", suf="n", names=True))
    results.append(check("empty_both", pre="qq", suf="zz"))
    out["all_pass"] = all(results)

    # highlight: both ends marked
    setf(pre="ca", suf="er")
    html = pg.locator(".card .word").first.inner_html()
    out["highlight"] = {"html": html, "marks": pg.locator(".card .word").first.locator("mark").count()}

    # sorts still work with a two-sided pattern
    setf(pre="c", suf="e")
    pg.select_option("#sort", "az"); pg.wait_for_timeout(350)
    w = [x.strip().lower() for x in pg.locator(".card .word").all_inner_texts()]
    out["az_sorted"] = w == sorted(w)
    pg.select_option("#sort", "len-asc"); pg.wait_for_timeout(350)
    w = [x.strip().lower() for x in pg.locator(".card .word").all_inner_texts()]
    out["len_asc"] = [len(x) for x in w] == sorted(len(x) for x in w)
    pg.select_option("#sort", "common"); pg.select_option("#limit", "30"); pg.wait_for_timeout(350)

    # default state + reset
    pg.click("#resetBtn"); pg.wait_for_timeout(350)
    out["reset"] = {"cards": pg.locator(".card").count(),
                    "q": pg.input_value("#q") + "|" + pg.input_value("#qc") + "|" + pg.input_value("#qs"),
                    "summary": pg.inner_text("#summary")}
    # empty state copy
    setf(pre="qq", suf="zz"); out["empty"] = pg.inner_text(".empty")[:90]

    pg.click("#resetBtn"); pg.wait_for_timeout(300)
    pg.fill("#q", "ca"); pg.fill("#qs", "er"); pg.wait_for_timeout(500)
    pg.screenshot(path="/workspace/lexiword/test/both_ends.png")

    m = b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    m.goto(URL); m.wait_for_selector(".card", timeout=25000)
    m.fill("#q", "st"); m.fill("#qs", "ing"); m.wait_for_timeout(450)
    m.screenshot(path="/workspace/lexiword/test/both_ends_mobile.png")
    out["mobile_overflow"] = m.evaluate("document.documentElement.scrollWidth > innerWidth")
    out["errors"] = errs
    b.close()

print(json.dumps(out, indent=1))
