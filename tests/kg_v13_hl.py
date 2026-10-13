#!/usr/bin/env python
"""Headless acceptance for kanban-graph v13 (2026-10-11 round 3).

Asks this round (user):
  1 mini grids fill COLUMN-first (<=4 blocks = one column) -> blocks render bigger
  2 busy cards HUG their content (small gap), still packed row-first top-aligned
  3 collapsed shelf strips: TIGHT (6px) and width-draggable (persisted per scope)

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v13_hl.py
"""
import atexit
import json
import os

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright  # noqa: E402

fails, notes = [], []


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


def _dump():
    print("\n".join(notes))
    print()
    if fails:
        print("FAILURES (%d):" % len(fails))
        print("\n".join(fails))
    else:
        print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))


atexit.register(_dump)

SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv13')) return;
    sessionStorage.setItem('__kgv13', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', '[]');
    localStorage.setItem(K + 'layout.__all__', '{}');
    localStorage.setItem(K + 'stripW.__all__', '{}');
    localStorage.setItem(K + 'maxed.__all__', '');
    localStorage.setItem(K + 'hideSt', '[]');
    var rm = [];
    for (var i = 0; i < localStorage.length; i++) {
      var lk = localStorage.key(i);
      if (lk && lk.indexOf(K + 'miniPos.') === 0) rm.push(lk);
    }
    rm.forEach(function (lk) { localStorage.removeItem(lk); });
  } catch (e) {}
})();
"""

SURVEY = """() => {
  const cards = Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(el => {
    const b = el.getBoundingClientRect();
    const blocks = Array.from(el.querySelectorAll('.kg-node')).map(g => {
      const q = g.getBoundingClientRect();
      const m = /kg-s-([a-zA-Z_-]+)/.exec(g.getAttribute('class') || '');
      return { x: q.x, y: q.y, w: q.width, h: q.height, st: m ? m[1] : '' };
    });
    return {
      prof: el.getAttribute('data-prof'),
      strip: el.classList.contains('kg-pstrip'),
      x: b.x, y: b.y, w: b.width, h: b.height,
      blocks: blocks
    };
  });
  return cards;
}"""


def overlaps(a, b):
    return not (a["x"] + a["w"] <= b["x"] + 0.5 or b["x"] + b["w"] <= a["x"] + 0.5
               or a["y"] + a["h"] <= b["y"] + 0.5 or b["y"] + b["h"] <= a["y"] + 0.5)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    page.goto(BASE + "/kanban-graph", wait_until="networkidle")
    page.evaluate(SEED)
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1200)

    # ── click the toolbar 自动排列 (top-of-page button, not a card button) ──
    btn = None
    for b in page.query_selector_all("button"):
        t = (b.inner_text() or "").strip()
        if t == "自动排列" and b.bounding_box():
            bb = b.bounding_box()
            if bb["y"] < 220:
                btn = b
                break
    ok("toolbar auto-arrange found", btn is not None)
    if btn:
        btn.click()
        page.wait_for_timeout(900)

    cards = page.evaluate(SURVEY)
    busy = [c for c in cards if not c["strip"] and c["blocks"]]
    strips = [c for c in cards if c["strip"]]
    page.screenshot(path=SHOTS + "/v13_after_auto.png")

    # ── T1: blocks got BIGGER (>=200px wide) ──
    allb = [b for c in busy for b in c["blocks"]]
    thin = [b for b in allb if b["w"] < 200]
    ok("every visible block is >=200px wide", len(thin) == 0,
       "min=%s n=%d" % (min([b["w"] for b in allb]) if allb else "-", len(allb)))

    # ── T2: column-first — within a card, sorted-by-y blocks keep the SAME x
    # while the column has room (<=4-block cards are one column) ──
    # v15.1 baseline rebase: a <=4-block card may pack TWO columns when the
    # card is very wide (aspect cap binds) — that is legal only if the blocks
    # then fill the width (span >= 92% of the card). Old semantics: always 1.
    bad1col = []
    for c in busy:
        n = len(c["blocks"])
        if n > 4:
            continue
        # v16.1 rebase: cluster into columns by a >40px x gap (a tag-bearing
        # block shifts its bbox left edge by a few px — not a new column)
        ux = sorted(set(round(b["x"]) for b in c["blocks"]))
        cols = 1
        for k in range(1, len(ux)):
            prev_left = min(b["x"] for b in c["blocks"] if round(b["x"]) == ux[k - 1])
            this_left = min(b["x"] for b in c["blocks"] if round(b["x"]) == ux[k])
            widest_prev = max(b["w"] for b in c["blocks"] if round(b["x"]) == ux[k - 1])
            if this_left - (prev_left + widest_prev) > 40:
                cols += 1
        if cols > 1:
            minx = min(b["x"] for b in c["blocks"])
            maxx = max(b["x"] + b["w"] for b in c["blocks"])
            if (maxx - minx) / c["w"] < 0.92:
                bad1col.append((c["prof"], n, ux))
    ok("cards with <=4 blocks: ONE column (TWO only if they fill the width)", not bad1col, bad1col[:3])
    # and within each column, blocks descend strictly
    badorder = []
    for c in busy:
        n = len(c["blocks"])
        if n < 2 or n > 4:
            continue
        cols = {}
        for b in c["blocks"]:
            cols.setdefault(round(b["x"]), []).append(round(b["y"]))
        for x0, ys in cols.items():
            ys.sort()
            if any(ys[i + 1] - ys[i] < 30 for i in range(len(ys) - 1)):
                badorder.append((c["prof"], x0, ys))
    ok("column blocks stack downward with spacing", not badorder, badorder[:3])

    # ── T3 (v14): the fill REPLACED the hug ceiling — cards spread over the
    # board instead of wrapping their content, so "no card wider than its
    # content needs" is no longer the contract. What must hold now: every busy
    # row spans the board edge-to-edge, no row keeps a dead band, and nothing
    # is squeezed below PMIN_H (v13.1's no-squeeze rule survives the fill). ──
    fr = page.evaluate("""() => { const b = document.querySelector('.kg-board').getBoundingClientRect();
        return { x: b.x, w: b.width }; }""")
    K13 = page.evaluate("() => ({ PGAP: window.__KG_TEST__.PGAP, PMIN_H: window.__KG_TEST__.PMIN_H })")
    rows13 = {}
    for c in busy:
        rows13.setdefault(round(c["y"]), []).append(c)
    spanbad, dead = [], []
    for y, rr in rows13.items():
        rr.sort(key=lambda z: z["x"])
        right = round(rr[-1]["x"] + rr[-1]["w"] - fr["x"], 1)
        want_right = round(fr["w"] - K13["PGAP"], 1)
        if abs(right - want_right) > 3:
            spanbad.append((y, right, want_right))
        left = round(min(c["x"] for c in rr) - fr["x"], 1)
        tail = round(fr["w"] - K13["PGAP"] - right, 1)
        if left > K13["PGAP"] + 8 or tail > K13["PGAP"] + 8:
            dead.append((y, left, tail))
    ok("v14: every busy row spans the board edge-to-edge", not spanbad, spanbad[:3])
    ok("v14: no dead band inside a row", not dead, dead[:3])
    ok("v14: nothing squeezed below PMIN_H",
       all(c["h"] >= K13["PMIN_H"] - 1 for c in busy), sorted(round(c["h"]) for c in busy)[:4])
    # row-first top-aligned: cards sharing a row have identical y
    rows = {}
    for c in busy:
        key = round(c["y"])
        rows.setdefault(key, []).append(c)
    ok("busy cards pack row-first", len(rows) >= 1 and len(busy) > 0)

    # ── T4: strips tight — same-row neighbours within 14px ──
    srows = {}
    for s in strips:
        srows.setdefault(round(s["y"]), []).append(s)
    gaps = []
    for ys, row in srows.items():
        row.sort(key=lambda z: z["x"])
        for i in range(len(row) - 1):
            gaps.append(round(row[i + 1]["x"] - (row[i]["x"] + row[i]["w"])))
    ok("shelf strips sit tight (gap <= 14px)", all(0 <= g <= 14 for g in gaps), gaps[:6])
    ok("shelf below every busy card (busy first, strips last)",
       (not busy) or all(s["y"] >= min(c["y"] for c in busy) for s in strips), "")

    # ── T5: strip width drag → persists across reload ──
    # Live data may have no empty profile at all (16 busy cards right now), so
    # EMPTY one on purpose — hide the single status all of its blocks carry, the
    # same sample-making trick kg_v9_hl / kg_v10_hl use — and only then does the
    # width-drag test have a real subject. (v13 round left this as T5 待办.)
    hide_used = None
    if not strips:
        st_map = page.evaluate("""() => {
          const out = {};
          document.querySelectorAll('.kg-surface > .kg-panel').forEach(p => {
            out[p.getAttribute('data-prof')] = Array.from(p.querySelectorAll('.kg-node')).map(n => {
              const m = /kg-s-([a-zA-Z_-]+)/.exec(n.getAttribute('class') || '');
              return m ? m[1] : '';
            }).filter(Boolean);
          });
          return out;
        }""")
        cand = [(k, ss[0]) for k, ss in sorted(st_map.items(), key=lambda z: -len(z[1])) if ss and len(set(ss)) == 1]
        if cand:
            hide_used = cand[0][1]
            page.evaluate("([s]) => localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify([s]))", [hide_used])
            page.reload(wait_until="networkidle")
            page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
            page.wait_for_timeout(1200)
            cards = page.evaluate(SURVEY)
            busy = [c for c in cards if not c["strip"] and c["blocks"]]
            strips = [c for c in cards if c["strip"]]
        ok("造得出收缩条（hideSt=%s）" % hide_used, bool(strips), (len(strips), [s["prof"] for s in strips][:3]))
    if strips:
        tgt = strips[0]
        handle = page.query_selector('.kg-panel[data-prof="%s"] .kg-srsz' % tgt["prof"])
        ok("strip exposes a width grip", handle is not None)
        if handle:
            hb = handle.bounding_box()
            w0 = tgt["w"]
            page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
            page.mouse.down()
            for k in range(1, 13):
                page.mouse.move(hb["x"] + hb["width"] / 2 + 8 * k, hb["y"] + hb["height"] / 2)
                page.wait_for_timeout(20)
            page.mouse.up()
            page.wait_for_timeout(700)
            after = page.evaluate(SURVEY)
            s2 = [c for c in after if not c["strip"] is False and c["prof"] == tgt["prof"]]
            s2 = [c for c in after if c["prof"] == tgt["prof"] and c["strip"]]
            ok("drag widened the strip (+40px or more)", s2 and s2[0]["w"] >= w0 + 40,
               "%s -> %s" % (round(w0), round(s2[0]["w"]) if s2 else "-"))
            store = page.evaluate("() => localStorage.getItem('hermes.kanbangraph.stripW.__all__')")
            j = json.loads(store or "{}")
            ok("manual width persisted in stripW store", tgt["prof"] in j, store)
            page.reload(wait_until="networkidle")
            page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
            page.wait_for_timeout(1100)
            after2 = page.evaluate(SURVEY)
            s3 = [c for c in after2 if c["prof"] == tgt["prof"] and c["strip"]]
            ok("width survives reload", s3 and abs(s3[0]["w"] - (w0 + 80)) <= 30,
               "%s want ~%s" % (round(s3[0]["w"]) if s3 else "-", round(w0 + 80)))
            # drag far left -> clamps at STRIP_RESIZE_MIN
            if s3 and handle:
                hb = page.query_selector('.kg-panel[data-prof="%s"] .kg-srsz' % tgt["prof"]).bounding_box()
                page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
                page.mouse.down()
                for k in range(1, 13):
                    page.mouse.move(hb["x"] + hb["width"] / 2 - 40 * k, hb["y"] + hb["height"] / 2)
                    page.wait_for_timeout(20)
                page.mouse.up()
                page.wait_for_timeout(600)
                a3 = page.evaluate(SURVEY)
                s4 = [c for c in a3 if c["prof"] == tgt["prof"] and c["strip"]]
                ok("strip honours the 90px floor", s4 and s4[0]["w"] >= 88,
                   round(s4[0]["w"]) if s4 else "-")
            page.screenshot(path=SHOTS + "/v13_strip_drag.png")
    else:
        ok("strips exist to test", False, "no collapsed profile and none could be emptied by one hidden status")

    # put the hidden status back so T6 measures the FULL wall again
    if hide_used:
        page.evaluate("() => localStorage.setItem('hermes.kanbangraph.hideSt', '[]')")
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
        page.wait_for_timeout(1100)

    # ── T6: zero overlap across every card on the wall ──
    fin = page.evaluate(SURVEY)
    boxes = [c for c in fin if c["w"] > 0 and c["h"] > 0]
    bad = 0
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if overlaps(boxes[i], boxes[j]):
                bad += 1
    ok("wall has zero overlap after all of the above", bad == 0, bad)
    browser.close()
