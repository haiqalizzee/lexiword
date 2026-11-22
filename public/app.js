// LexiFind — client-side word finder.
// All search runs in memory over typed arrays; definitions are lazy-loaded per letter.

const F_NAME_ONLY = 1, F_ROMAN = 2, F_ROMAN_ONLY = 4, F_NAME = 16;
const POS_BITS = { n: 1, v: 2, adj: 4, adv: 8, num: 16 };
const POS_LABEL = { n: "Noun", v: "Verb", adj: "Adj.", adv: "Adv.", num: "Numeral" };
const RENDER_CHUNK = 100;
const PAGE_LIMIT_ALL = Infinity;

const $ = (id) => document.getElementById(id);
const els = {
  q: $("q"), qc: $("qc"), qs: $("qs"),
  grid: $("grid"), summary: $("summary"), hint: $("hint"), moreBtn: $("moreBtn"),
  lenMode: $("lenMode"), lenInputs: $("lenInputs"), lenA: $("lenA"), lenB: $("lenB"),
  lenBWrap: $("lenBWrap"), lenALabel: $("lenALabel"), sort: $("sort"), limit: $("limit"),
  roman: $("romanToggle"), names: $("nameToggle"), reset: $("resetBtn"), form: $("searchForm"),
  corpusChip: $("corpusChip"), footStats: $("footStats"),
};

// ---------- corpus state ----------
let N = 0;
let W = [];                // words, alphabetical
let Z = new Uint8Array(0); // commonness (Zipf * 10)
let FL = new Uint8Array(0);// flags
let POS = new Uint8Array(0);// POS bitmask
let VAL = new Uint16Array(0);// Roman value (0 = none)
let COMMON = new Int32Array(0); // indices ordered by commonness desc, then A–Z
let ready = false;
let renderCount = RENDER_CHUNK;
let lastItems = [];
let lastState = null;
let debounceTimer = 0;

const CORPUS_PARTS = ["data/words-1.txt", "data/words-2.txt"];

async function loadCorpus() {
  // Two alphabetical halves; keep hosts happy with their 2 MiB file cap.
  const parts = await Promise.all(CORPUS_PARTS.map((u) =>
    fetch(u).then((r) => {
      if (!r.ok) throw new Error("Could not load word list");
      return r.text();
    })));
  const text = parts.join("");
  if (!text) throw new Error("Empty word list");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  N = lines.length;
  W = new Array(N); Z = new Uint8Array(N); FL = new Uint8Array(N);
  POS = new Uint8Array(N); VAL = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    const parts = lines[i].split("\t");
    W[i] = parts[0];
    Z[i] = Math.min(255, +parts[1] || 0);
    FL[i] = +parts[2] || 0;
    let p = 0;
    if (parts[3]) for (const tok of parts[3].split("|")) p |= POS_BITS[tok] || 0;
    POS[i] = p;
    VAL[i] = +parts[4] || 0;
  }
  // Counting sort: commonness descending, stable so ties stay alphabetical.
  const buckets = new Array(256).fill(0).map(() => []);
  for (let i = 0; i < N; i++) buckets[Z[i]].push(i);
  COMMON = new Int32Array(N);
  let k = 0;
  for (let z = 255; z >= 0; z--) for (const i of buckets[z]) COMMON[k++] = i;
  ready = true;
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------- search ----------
function cleanLetters(v) {
  return v.toLowerCase().replace(/[^a-z]/g, "");
}
function readState() {
  let a = clampLen(els.lenA.value), b = clampLen(els.lenB.value);
  if (a && b && a > b) [a, b] = [b, a];
  return {
    pre: cleanLetters(els.q.value),
    mid: cleanLetters(els.qc.value),
    suf: cleanLetters(els.qs.value),
    lenMode: els.lenMode.value,
    lenA: a, lenB: b,
    sort: els.sort.value,
    limit: +els.limit.value,         // 0 = All
    roman: els.roman.checked,
    names: els.names.checked,
  };
}
function clampLen(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 0;
}

function search(st) {
  const { pre, mid, suf, roman, names } = st;
  const lenFilter = (() => {
    if (st.lenMode === "exact" && st.lenA) return (L) => L === st.lenA;
    if (st.lenMode === "range") {
      const lo = st.lenA || 1, hi = st.lenB || 30;
      return (L) => L >= lo && L <= hi;
    }
    return null;
  })();

  const test = (i) => {
    const f = FL[i];
    if ((f & F_ROMAN_ONLY) && !roman) return false;
    if ((f & F_NAME_ONLY) && !names) return false;
    const w = W[i];
    if (lenFilter && !lenFilter(w.length)) return false;
    if (pre && !w.startsWith(pre)) return false;
    if (suf && !w.endsWith(suf)) return false;
    if (mid && !w.includes(mid)) return false;
    return true;
  };

  const cap = st.limit === 0 ? PAGE_LIMIT_ALL : st.limit;
  const items = [];
  let total = 0;

  // A prefix narrows the alphabetical range via binary search; the other
  // fields only ever remove entries, so this range stays valid.
  let lo = 0, hi = N;
  if (pre) {
    lo = lowerBound(W, pre);
    hi = lowerBound(W, pre + "{"); // "{" sorts right after "z"
  }

  if (st.sort === "common") {
    for (let k = 0; k < N; k++) {
      const i = COMMON[k];
      if (!test(i)) continue;
      total++;
      if (items.length < cap) items.push(i);
    }
  } else if (st.sort === "az" || st.sort === "za") {
    const reverse = st.sort === "za";
    for (let j = 0; j < hi - lo; j++) {
      const i = reverse ? hi - 1 - j : lo + j;
      if (!test(i)) continue;
      total++;
      if (items.length < cap) items.push(i);
    }
  } else {
    // Length sort: gather all matches (alphabetical), then stable bucket by length.
    const all = [];
    for (let i = lo; i < hi; i++) if (test(i)) all.push(i);
    total = all.length;
    const asc = st.sort === "len-asc";
    const buckets = Array.from({ length: 31 }, () => []);
    for (const i of all) buckets[Math.min(30, W[i].length)].push(i);
    const order = asc ? buckets : buckets.reverse();
    outer: for (const b of order) for (const i of b) {
      items.push(i);
      if (items.length >= cap) break outer;
    }
  }
  return { total, items };
}

// ---------- definitions ----------
const defCache = new Map();   // letter -> Promise<Map<word, string[]>>
const apiCache = new Map();   // word -> Promise<{pos, def} | null>
const apiQueue = [];
let apiActive = 0;

function loadLetterDefs(letter) {
  if (!defCache.has(letter)) {
    defCache.set(letter, fetch(`data/defs/${letter}.txt`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        const m = new Map();
        for (const line of t.split("\n")) {
          if (!line) continue;
          const parts = line.split("\t");
          m.set(parts[0], parts.slice(1));
        }
        return m;
      })
      .catch(() => new Map()));
  }
  return defCache.get(letter);
}

function fetchApiDef(word) {
  if (!apiCache.has(word)) {
    apiCache.set(word, new Promise((resolve) => {
      apiQueue.push({ word, resolve });
      pumpApi();
    }));
  }
  return apiCache.get(word);
}
function pumpApi() {
  while (apiActive < 4 && apiQueue.length) {
    const { word, resolve } = apiQueue.shift();
    apiActive++;
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const m = Array.isArray(j) && j[0] && j[0].meanings && j[0].meanings[0];
        const d = m && m.definitions && m.definitions[0] && m.definitions[0].definition;
        resolve(d ? { pos: m.partOfSpeech || "", def: d } : null);
      })
      .catch(() => resolve(null))
      .finally(() => { apiActive--; pumpApi(); });
  }
}

// ---------- rendering ----------
function tierOf(z10) {
  if (z10 >= 40) return ["Common", true];
  if (z10 >= 30) return ["Familiar", false];
  if (z10 >= 15) return ["Uncommon", false];
  return ["Obscure", false];
}

function highlight(el, w, st) {
  const ranges = [];
  const { pre, mid, suf } = st;
  if (pre && w.startsWith(pre)) ranges.push([0, pre.length]);
  if (suf && w.endsWith(suf)) ranges.push([w.length - suf.length, w.length]);
  if (mid) {
    let at = w.indexOf(mid);
    while (at !== -1) {
      ranges.push([at, at + mid.length]);
      at = w.indexOf(mid, at + mid.length);
    }
  }
  el.replaceChildren();
  if (!ranges.length) { el.textContent = w; return; }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) el.append(w.slice(pos, s));
    const m = document.createElement("mark");
    m.textContent = w.slice(s, e);
    el.append(m);
    pos = e;
  }
  if (pos < w.length) el.append(w.slice(pos));
}

function badge(text, cls) {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
}

function buildCard(i, st) {
  const w = W[i], f = FL[i], p = POS[i];
  const card = document.createElement("article");
  card.className = "card";

  const top = document.createElement("div");
  top.className = "card-top";
  const wordBtn = document.createElement("button");
  wordBtn.type = "button";
  wordBtn.className = "word";
  wordBtn.title = "Click to copy";
  highlight(wordBtn, w, st);
  wordBtn.addEventListener("click", () => copyWord(w, card));
  const len = document.createElement("span");
  len.className = "len";
  len.textContent = `${w.length} letters`;
  top.append(wordBtn, len);

  const badges = document.createElement("div");
  badges.className = "badges";
  for (const [key, bit] of Object.entries(POS_BITS)) {
    if (p & bit) badges.append(badge(POS_LABEL[key], "pos-" + key));
  }
  const [tierName, isCommon] = tierOf(Z[i]);
  badges.append(badge(tierName, isCommon ? "tier-common" : ""));
  if (f & F_NAME) badges.append(badge("Name", "name"));
  if (f & F_ROMAN) badges.append(badge(`Roman · ${VAL[i]}`, "pos-num"));

  const def = document.createElement("p");
  def.className = "def muted";
  def.textContent = "Loading definition…";
  def.dataset.word = w;

  const foot = document.createElement("div");
  foot.className = "card-foot";
  const copied = document.createElement("span");
  copied.className = "copied";
  copied.textContent = "Copied";
  copied.setAttribute("aria-live", "polite");
  const mw = document.createElement("a");
  mw.className = "mw";
  mw.href = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(w)}`;
  mw.target = "_blank";
  mw.rel = "noopener noreferrer";
  mw.textContent = "M-W ↗";
  mw.setAttribute("aria-label", `Look up ${w} on Merriam-Webster (opens in new tab)`);
  foot.append(copied, mw);

  card.append(top, badges, def, foot);
  return card;
}

function copyWord(w, card) {
  const done = () => {
    const c = card.querySelector(".copied");
    c.classList.add("show");
    setTimeout(() => c.classList.remove("show"), 1200);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(w).then(done, () => {});
}

function fillDefinitions(cards) {
  // Local WordNet definitions load per letter; words without one get an on-demand lookup button.
  const byLetter = new Map();
  for (const [el, w] of cards) {
    const L = w[0];
    if (!byLetter.has(L)) byLetter.set(L, []);
    byLetter.get(L).push([el, w]);
  }
  for (const [L, list] of byLetter) {
    loadLetterDefs(L).then((map) => {
      for (const [el, w] of list) {
        if (!el.isConnected) continue;
        const entry = map.get(w);
        if (entry && entry.length) setDef(el, entry.join(" · "), false);
        else offerLookup(el, w);
      }
    });
  }
}

function offerLookup(card, w) {
  const p = card.querySelector(".def");
  if (!p) return;
  p.textContent = "";
  p.classList.add("muted");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lookup";
  btn.textContent = "Look up definition";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Looking up…";
    fetchApiDef(w).then((r) => {
      if (r) setDef(card, (r.pos ? r.pos + ": " : "") + r.def, false);
      else setDef(card, "No definition found. Open M-W for the full entry.", true);
    });
  });
  p.append(btn);
}

function setDef(card, text, muted) {
  const p = card.querySelector(".def");
  if (!p || !p.isConnected) return;
  p.textContent = text;
  p.classList.toggle("muted", !!muted);
}

function describeState(st, total) {
  const parts = [];
  if (st.pre) parts.push(`starts with “${st.pre}”`);
  if (st.mid) parts.push(`contains “${st.mid}”`);
  if (st.suf) parts.push(`ends with “${st.suf}”`);
  if (st.lenMode === "exact" && st.lenA) parts.push(`${st.lenA} letters`);
  if (st.lenMode === "range") parts.push(`${st.lenA || 1}–${st.lenB || 30} letters`);
  return parts.join(" · ");
}

function render(st, result) {
  const { total, items } = result;
  lastItems = items;
  lastState = st;
  const shownTotal = Math.min(renderCount, items.length);
  const fmt = (n) => n.toLocaleString("en-US");

  // summary + hints
  if (!st.pre && !st.mid && !st.suf) {
    els.summary.textContent = `Most common playable words${st.lenMode !== "any" ? " · " + describeState(st) : ""}`;
    els.hint.textContent = `${fmt(total)} words match the current filters. Type letters to search.`;
  } else {
    els.summary.textContent = `${fmt(total)} match${total === 1 ? "" : "es"}`;
    const shownTxt = items.length < total
      ? `Showing ${fmt(Math.min(items.length, shownTotal))} of ${fmt(total)} · ${describeState(st)}`
      : describeState(st);
    els.hint.textContent = shownTxt;
  }

  els.grid.setAttribute("aria-busy", "false");
  els.grid.replaceChildren();
  if (total === 0) {
    els.grid.append(emptyState(st));
    els.moreBtn.hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  const cards = [];
  for (let k = 0; k < shownTotal; k++) {
    const el = buildCard(items[k], st);
    frag.append(el);
    cards.push([el, W[items[k]]]);
  }
  els.grid.append(frag);
  fillDefinitions(cards);
  els.moreBtn.hidden = items.length <= shownTotal;
  els.moreBtn.textContent = `Show ${fmt(Math.min(RENDER_CHUNK, items.length - shownTotal))} more`;
}

function emptyState(st) {
  const box = document.createElement("div");
  box.className = "empty";
  box.setAttribute("role", "status");
  const h = document.createElement("h2");
  h.textContent = "No playable words match";
  const p = document.createElement("p");
  p.textContent = describeState(st)
    ? `Nothing in the corpus ${describeState(st)}.`
    : "Nothing matches these length filters.";
  const ul = document.createElement("ul");
  const tips = [
    st.lenMode !== "any" && "Set length to Any, or widen the range",
    (st.pre || st.mid || st.suf) && "Relax one of the three letter boxes",
    (st.pre.length > 4 || st.mid.length > 4 || st.suf.length > 4) && "Shorten the letters: fewer letters match more words",
    "Turn on Roman numerals or Playable human names for extra entries",
  ].filter(Boolean);
  for (const t of tips) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn"; btn.textContent = "Reset filters";
  btn.addEventListener("click", resetFilters);
  box.append(h, p, ul, btn);
  return box;
}

function showSkeleton() {
  els.grid.setAttribute("aria-busy", "true");
  els.grid.replaceChildren(...Array.from({ length: 6 }, () => {
    const s = document.createElement("div");
    s.className = "skeleton";
    s.innerHTML = "<i></i><i></i><i></i><i></i>";
    return s;
  }));
  els.summary.textContent = "Loading word corpus…";
  els.hint.textContent = "";
}

// ---------- wiring ----------
function run() {
  if (!ready) return;
  const st = readState();
  const t0 = performance.now();
  const result = search(st);
  const ms = performance.now() - t0;
  render(st, result);
  els.hint.title = `Search took ${ms.toFixed(1)} ms over ${N.toLocaleString()} entries`;
}
let renderScheduled = false;
function schedule(resetCount = true) {
  if (resetCount) renderCount = RENDER_CHUNK;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; run(); });
  }, 60);
}

function syncLengthUI() {
  const m = els.lenMode.value;
  els.lenInputs.hidden = m === "any";
  els.lenBWrap.hidden = m !== "range";
  els.lenALabel.textContent = m === "range" ? "Min" : "Length";
  if (m === "exact") els.lenA.setAttribute("aria-label", "Exact length");
}

function resetFilters() {
  els.q.value = "";
  els.qc.value = "";
  els.qs.value = "";
  els.lenMode.value = "any";
  els.lenA.value = 5; els.lenB.value = 7;
  els.sort.value = "common"; els.limit.value = "30";
  els.roman.checked = false; els.names.checked = false;
  syncLengthUI();
  schedule();
  els.q.focus();
}

function bind() {
  for (const el of [els.q, els.qc, els.qs]) {
    el.addEventListener("input", () => {
      const clean = cleanLetters(el.value);
      if (clean !== el.value) el.value = clean;
      schedule();
    });
  }
  for (const el of [els.sort, els.limit, els.roman, els.names]) el.addEventListener("change", () => schedule());
  els.lenMode.addEventListener("change", () => { syncLengthUI(); schedule(); });
  for (const el of [els.lenA, els.lenB]) el.addEventListener("input", () => schedule());
  els.form.addEventListener("submit", (e) => { e.preventDefault(); schedule(); });
  els.reset.addEventListener("click", resetFilters);
  els.moreBtn.addEventListener("click", () => {
    renderCount += RENDER_CHUNK;
    run();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== els.q && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); els.q.focus();
    }
  });
  syncLengthUI();
}

async function main() {
  bind();
  showSkeleton();
  try {
    const [, statsRes] = await Promise.all([
      loadCorpus(),
      fetch("data/stats.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    els.corpusChip.textContent = `${N.toLocaleString("en-US")} playable entries`;
    if (statsRes) {
      const s = statsRes;
      els.footStats.textContent =
        `Corpus: ${s.enable_entries_lowercase_2plus.toLocaleString()} ENABLE entries → ` +
        `${s.playable_entries.toLocaleString()} playable. Removed ${s.dropped_scientific_jargon.toLocaleString()} scientific terms ` +
        `and ${s.dropped_proper_noun.toLocaleString()} proper nouns. Roman numerals: ${(s.roman_numerals_added + s.roman_also_dictionary_word).toLocaleString()}.`;
    }
    run();
  } catch (err) {
    els.grid.setAttribute("aria-busy", "false");
    els.grid.replaceChildren(emptyState({ pre: "", mid: "", suf: "", lenMode: "any" }));
    els.grid.querySelector("h2").textContent = "Couldn't load the word list";
    els.corpusChip.textContent = "Load failed";
    console.error(err);
  }
}

main();
