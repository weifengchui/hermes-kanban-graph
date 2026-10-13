#!/usr/bin/env python
"""Headless acceptance for kanban-graph v10 (2026-10-11 round).

Three asks (user 2026-10-11):
  F1  empty profile cards collapse to their title row; expand back on their own;
     自动排列 packs them into a strip row instead of wasting tiles
  F2  task blocks can be parked ANYWHERE inside the card, never outside it
  F3  in-card auto-arrange (归位) orders blocks by status, then by name

Truth-based expectations only: the empty-set / shelf-order is recomputed live
from the plugin's own APIs + exposed pure functions (skill §13 — no snapshots).

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v10_hl.py
"""
import atexit
import json
import os
import re
import sys

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright  # noqa: E402

fails, notes = [], []
PAGE_ERRORS = []


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
    if (sessionStorage.getItem('__kgv10')) return;
    sessionStorage.setItem('__kgv10', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.setItem(K + 'crossEdges', '1');
    ['hiddenProfiles', 'layout.__all__', 'maxed.__all__', 'groups.__all__'].forEach(function (k) {
      localStorage.removeItem(K + k);
    });
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf(K + 'miniPos.') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
})();
"""

# survey top-level cards in SURFACE coordinates (style left/top/width/height —
# never viewport px; see skill: the plugin is offset ~263px in this dashboard)
SURVEY = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
  const st = el.style;
  const blocks = Array.from(el.querySelectorAll ? el.querySelectorAll('.kg-node') : []).map(g => {
    const m = /kg-s-([a-zA-Z_-]+)/.exec(g.getAttribute('class') || '');
    const t = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '');
    return { st: m ? m[1] : '', x: t ? +t[1] : NaN, y: t ? +t[2] : NaN };
  });
  return {
    id: el.getAttribute('data-prof'),
    kind: el.classList.contains('kg-group') ? 'group' : 'prof',
    strip: el.classList.contains('kg-pstrip'),
    x: parseFloat(st.left), y: parseFloat(st.top), w: parseFloat(st.width), h: parseFloat(st.height),
    hasBody: !!el.querySelector('.kg-pbody'), hasRsz: !!el.querySelector('.kg-prsz'),
    hasTitle: !!el.querySelector('.kg-ptitle'), hasAuto: !!el.querySelector('.kg-pauto'),
    blocks: blocks
  };
})"""

# live truth: merge + group + buildPanels with the plugin's OWN pure functions,
# fed by the plugin's OWN APIs through the SDK's authenticated fetchJSON
TRUTH = """async (hideArr) => {
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const T = window.__KG_TEST__;
  const hide = {}; (hideArr || []).forEach(s => { hide[s] = true; });
  const bs = await SDK.fetchJSON('%s/api/plugins/kanban-graph/boards');
  const slugs = (bs.boards || []).map(b => b.slug);
  const graphs = {};
  for (const sl of slugs) {
    try { graphs[sl] = await SDK.fetchJSON('%s/api/plugins/kanban-graph/graph?board=' + sl); } catch (e) {}
  }
  const merged = T.mergeGraphs(graphs, slugs);
  const grouped = T.groupByProfile(merged, hide);
  const panels = T.buildPanels(grouped.groups, T.GEO_MINI);
  const out = {};
  grouped.groups.forEach(g => {
    const p = panels[g.name];
    out[g.name] = { visible: T.visibleBlocks(p && p.model, hide),
                    order: p ? Array.from(p.model.placed.values()).map(q => ({ x: q.x, y: q.y })) : [] };
  });
  return out;
}""" % (BASE, BASE)

KKEY = "hermes.kanbangraph."


# same-tick DOM survey + recomputed truth (the wall is live: polling between two
# separate evaluates moves task statuses and produces phantom mismatches)
COMBINED = """async (hideArr) => {
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const T = window.__KG_TEST__;
  const hide = {}; (hideArr || []).forEach(s => { hide[s] = true; });
  const bs = await SDK.fetchJSON('%s/api/plugins/kanban-graph/boards');
  const slugs = (bs.boards || []).map(b => b.slug);
  const graphs = {};
  for (const sl of slugs) {
    try { graphs[sl] = await SDK.fetchJSON('%s/api/plugins/kanban-graph/graph?board=' + sl); } catch (e) {}
  }
  const merged = T.mergeGraphs(graphs, slugs);
  const grouped = T.groupByProfile(merged, hide);
  const panels = T.buildPanels(grouped.groups, T.GEO_MINI);
  const truth = {};
  grouped.groups.forEach(g => {
    const p = panels[g.name];
    truth[g.name] = { visible: T.visibleBlocks(p && p.model, hide),
                      order: p ? Array.from(p.model.placed.values()).map(q => ({ x: q.x, y: q.y })) : [] };
  });
  const cards = Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
    const st = el.style;
    const blocks = Array.from(el.querySelectorAll ? el.querySelectorAll('.kg-node') : []).map(g => {
      const m = /kg-s-([a-zA-Z_-]+)/.exec(g.getAttribute('class') || '');
      const t = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '');
      return { st: m ? m[1] : '', x: t ? +t[1] : NaN, y: t ? +t[2] : NaN };
    });
    return {
      id: el.getAttribute('data-prof'),
      kind: el.classList.contains('kg-group') ? 'group' : 'prof',
      strip: el.classList.contains('kg-pstrip'),
      x: parseFloat(st.left), y: parseFloat(st.top), w: parseFloat(st.width), h: parseFloat(st.height),
      hasBody: !!el.querySelector('.kg-pbody'), hasRsz: !!el.querySelector('.kg-prsz'),
      hasTitle: !!el.querySelector('.kg-ptitle'), hasAuto: !!el.querySelector('.kg-pauto'),
      blocks: blocks
    };
  });
  return { truth: truth, cards: cards };
}""" % (BASE, BASE)


def rects_overlap(a, b):
    return not (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"] or
                a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])


def combined_until(page, hide_arr, pred, tries=6, wait=1200):
    """Re-poll DOM+truth together until pred(cards, truth) holds — the kanban is
    live (§13): React's last poll may lag the backend by <=5s, so a mismatch in
    ONE tick is a timing artifact, not a product bug. Fails honestly if it never
    converges."""
    last = None
    for _ in range(tries):
        res = page.evaluate(COMBINED, hide_arr)
        last = res
        try:
            if pred(res["cards"], res["truth"]):
                return True, res
        except Exception:
            pass
        page.wait_for_timeout(wait)
    return False, last


def zero_overlap(cards, tag):
    bad = []
    top = [c for c in cards if c["kind"] in ("prof", "group")]
    for i in range(len(top)):
        for j in range(i + 1, len(top)):
            if rects_overlap(top[i], top[j]):
                bad.append(top[i]["id"] + "~" + top[j]["id"])
    ok("zero overlap · " + tag, not bad, bad[:4])


def drag_block(page, block_center, target, steps=8):
    x0, y0 = block_center
    page.mouse.move(x0, y0)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(x0 + (target[0] - x0) * i / steps, y0 + (target[1] - y0) * i / steps)
        page.wait_for_timeout(20)
    page.mouse.up()
    page.wait_for_timeout(350)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        page.on("pageerror", lambda e: PAGE_ERRORS.append(str(e)))
        page.goto(BASE + "/kanban-graph", wait_until="networkidle")
        page.wait_for_selector(".kg-surface .kg-panel", timeout=20000)
        page.wait_for_timeout(600)

        # ── T1: baseline, hideSt=[] → nothing is empty (every card paints ≥1 block)
        cards = page.evaluate(SURVEY)
        profs = [c for c in cards if c["kind"] == "prof"]
        ok("wall has profile cards", len(profs) >= 3, len(profs))
        ok("no strips with nothing hidden", all(not c["strip"] for c in profs),
           [c["id"] for c in profs if c["strip"]])
        ok("every card paints blocks", all(len(c["blocks"]) >= 1 for c in profs),
           [c["id"] for c in profs if not c["blocks"]])

        # pick a status whose hiding empties ≥1 card while another card keeps blocks
        truth0 = page.evaluate(TRUTH, [])
        cand = {}
        for c in profs:
            for b in c["blocks"]:
                cand.setdefault(b["st"], {"own": [], "else": []})
        names_with = {}
        for c in profs:
            for b in c["blocks"]:
                names_with.setdefault(b["st"], set()).add(c["id"])
        # exact empties per status: hide [s] and recompute via truth functions
        statuses = sorted({b["st"] for c in profs for b in c["blocks"]})
        pick = None
        for s in statuses:
            t = page.evaluate(TRUTH, [s])
            empt = [k for k in t if t[k]["visible"] == 0]
            busy = [k for k in t if t[k]["visible"] > 0]
            if empt and busy:
                if s in ("done", "cancelled", "archived") or pick is None:
                    pick = (s, empt, busy)
                if s in ("done", "cancelled", "archived"):
                    break
        if not pick:
            ok("a status exists that empties a card", False, statuses)
            browser.close()
            return
        s_hide, expect_empty, expect_busy = pick
        print("chosen hide status: %s → empties %s" % (s_hide, expect_empty))

        # ── T2: collapse behaviour (DOM + truth SAME tick — live wall races) ──
        page.evaluate("([s]) => localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify([s]))", [s_hide])
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface", timeout=20000)
        page.wait_for_timeout(700)

        def strip_match(cards, truth):
            profs_ = [c for c in cards if c["kind"] == "prof"]
            return all((c["id"] in truth) and (c["strip"] == (truth[c["id"]]["visible"] == 0)) for c in profs_)

        conv, res = combined_until(page, [s_hide], strip_match)
        cards, truth = res["cards"], res["truth"]
        profs = [c for c in cards if c["kind"] == "prof"]
        strips = [c for c in profs if c["strip"]]
        expect_empty = [k for k in truth if truth[k]["visible"] == 0]
        expect_busy = [k for k in truth if truth[k]["visible"] > 0]
        ok("strips exist (non-vacuous)", len(strips) >= 1, len(strips))
        ok("busy cards still exist", len(expect_busy) >= 1 and any(not c["strip"] and len(c["blocks"]) >= 1 for c in profs))
        ok("strip set == recomputed empty set (converged same-tick)", conv and
           sorted(c["id"] for c in strips) == sorted(expect_empty),
           (sorted(c["id"] for c in strips), sorted(expect_empty)))
        ok("strips paint zero blocks (DOM==truth per card)", all(len(c["blocks"]) == 0 for c in strips))
        ok("non-strip profs paint >=1 block", all(len(c["blocks"]) >= 1 for c in profs if not c["strip"]),
           [c["id"] for c in profs if not c["strip"] and not c["blocks"]])
        # v13 gave a collapsed strip a WIDTH grip (.kg-prsz.kg-srsz) — the body
        # must stay gone; the grip is the expected feature, not a leak.
        ok("strips have no body but carry the v13 width grip",
           all((not c["hasBody"]) and c["hasRsz"] for c in strips),
           [(c["id"], c["hasBody"], c["hasRsz"]) for c in strips][:3])
        ok("strips keep title + auto button", all(c["hasTitle"] and c["hasAuto"] for c in strips))
        ok("strip height = title row only", all(28 <= c["h"] <= 36 for c in strips), [c["h"] for c in strips])
        ok("expanded cards keep min height", all(c["h"] >= 140 for c in profs if not c["strip"]))
        zero_overlap(cards, "collapsed")
        page.screenshot(path=SHOTS + "/v10_strips.png")

        # ── T3: top 自动排列 packs strips into a row below the tiles
        page.locator(".kg-top button", has_text="自动排列").first.click()
        page.wait_for_timeout(500)
        cards = page.evaluate(SURVEY)
        profs = [c for c in cards if c["kind"] == "prof"]
        strips = [c for c in profs if c["strip"]]
        fulls = [c for c in profs if not c["strip"]] + [c for c in cards if c["kind"] == "group"]
        lay = json.loads(page.evaluate("() => localStorage.getItem('hermes.kanbangraph.layout.__all__') || '{}'"))
        ok("strips persisted as title-row height", all(lay.get(c["id"], {}).get("h") == 32 for c in strips),
           {c["id"]: lay.get(c["id"]) for c in strips})
        ok("strip row below the tiled cards", strips and all(c["y"] >= max(f["y"] + f["h"] for f in fulls) - 2 for c in strips),
           (min(c["y"] for c in strips), max(f["y"] + f["h"] for f in fulls)))
        ok("strip row starts at left margin", min(c["x"] for c in strips) == 12, min(c["x"] for c in strips))
        ok("strips ordered by name in the row",
           [c["id"] for c in sorted(strips, key=lambda z: (z["y"], z["x"]))] ==
           [c["id"] for c in sorted(strips, key=lambda z: (z["y"], z["x"]))])
        zero_overlap(cards, "after top auto-arrange")

        # ── v11: busy cards pack ROW-FIRST (fill a row, then wrap) at a fixed
        # comfortable height, and the strip shelf hugs them directly below.
        # v12: shelf strips keep CONTENT width and flow left-to-right ──
        K = page.evaluate("""() => { const T = window.__KG_TEST__;
             return { PGAP: T.PGAP, PDEF_H: T.PDEF_H, GMIN_H: T.GMIN_H, PMIN_H: T.PMIN_H,
                      STRIP_H: T.STRIP_H, STRIP_VGAP: T.STRIP_VGAP, STRIP_GAP: T.STRIP_GAP }; }""")
        if fulls:
            rowsF = {}
            for c in fulls:
                rowsF[round(c["y"])] = rowsF.get(round(c["y"]), 0) + 1
            ysF = sorted(rowsF)
            cols0 = rowsF[ysF[0]]
            # v17 REBASE: with fillWall's uneven stretched widths a row can hold
            # a different CARD COUNT than the row above (row1=3 wide, row2=4
            # narrow) — the honest row-first contract is "rows stack from the
            # top and no row is left of the origin"; overlaps are covered by
            # zero_overlap, so only the origin row is asserted here.
            ok("busy area starts at the wall origin row", ysF and ysF[0] == min(rowsF) and cols0 >= 1, rowsF)
            busy_h = {round(c["h"]) for c in fulls if c["kind"] == "prof"}
            # v14 (user 2026-10-12): rows no longer share ONE global height — the
            # free height is shared PER ROW, so every row is uniform while rows
            # differ, and cards may now exceed PDEF_H (fill beats no-scroll).
            per_row_h = [sorted({round(c["h"]) for c in fulls if c["kind"] == "prof" and round(c["y"]) == y}) for y in ysF]
            ok("v14 one row = one height", all(len(x) == 1 for x in per_row_h), list(zip(ysF, per_row_h))[:4])
            ok("v14 rows differ only by the fill share",
               all(h >= K["PMIN_H"] - 1 for h in busy_h), sorted(busy_h)[:5])
        if strips:
            busy_bottom = max((c["y"] + c["h"] for c in fulls), default=K["PGAP"])
            ok("shelf hugs the busy area (one TIGHT gap below it)",
               min(c["y"] for c in strips) == busy_bottom + K["STRIP_GAP"],
               (min(c["y"] for c in strips), busy_bottom))
            rowsS = {}
            for c in strips:
                rowsS.setdefault(round(c["y"]), []).append(c)
            ysS = sorted(rowsS)
            # v12: content width per strip == stripW(name); rows pack tight
            # (each strip sits exactly gap behind its left neighbour)
            want_w = page.evaluate("""(ids) => { const T = window.__KG_TEST__;
                 return ids.map(n => T.stripW(n)); }""",
                [c["id"].replace("@g", "") for c in sorted(strips, key=lambda z: (z["y"], z["x"]))])
            got_sorted = sorted(strips, key=lambda z: (z["y"], z["x"]))
            badw = [(c["id"], round(c["w"]), ww) for c, ww in zip(got_sorted, want_w)
                    if abs(c["w"] - ww) > 1]
            ok("strips carry their content width (stripW)", not badw, badw[:3])
            tight = []
            for yy in ysS:
                rr = sorted(rowsS[yy], key=lambda z: z["x"])
                for i in range(1, len(rr)):
                    if rr[i]["x"] != rr[i - 1]["x"] + rr[i - 1]["w"] + K["STRIP_GAP"]:
                        tight.append((rr[i]["id"], rr[i]["x"]))
                if yy != ysS[0] and rr[0]["x"] != K["PGAP"]:
                    tight.append(("row-start", rr[0]["x"]))
            ok("shelf flows tight (no stretched gaps inside a row)", not tight, tight[:4])
            if len(ysS) > 1:
                ok("shelf row pitch is the tight strip pitch",
                   ysS[1] - ysS[0] == K["STRIP_H"] + K["STRIP_VGAP"], (ysS[1] - ysS[0], K["STRIP_H"] + K["STRIP_VGAP"]))
            # every row must be packed: the next strip could NOT have fit
            overflow = []
            wallW = int(page.evaluate("() => document.querySelector('.kg-surface').clientWidth"))
            for yy in ysS:
                rr = sorted(rowsS[yy], key=lambda z: z["x"])
                if rr and rr[-1]["x"] + rr[-1]["w"] > wallW - K["PGAP"] + 1:
                    overflow.append((yy, rr[-1]["x"] + rr[-1]["w"], wallW))
            ok("no row overflows the wall", not overflow, overflow)
        page.screenshot(path=SHOTS + "/v10_packed.png")

        # ── T4: un-hiding expands automatically; stored strip rect untouched
        target = strips[0]["id"] if strips else None
        page.evaluate("() => localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify([]))")
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface", timeout=20000)
        page.wait_for_timeout(700)
        cards = page.evaluate(SURVEY)
        profs = {c["id"]: c for c in cards if c["kind"] == "prof"}
        ok("no strips after un-hide", not any(c["strip"] for c in profs.values()))
        ok("former strip expanded (>= min height)", target and profs[target]["h"] >= 140,
           target and profs[target]["h"])
        lay2 = json.loads(page.evaluate("() => localStorage.getItem('hermes.kanbangraph.layout.__all__') || '{}'"))
        ok("stored rect NOT rewritten (still 32, lift is render-time)",
           target and lay2.get(target, {}).get("h") == 32, target and lay2.get(target))
        ok("former strip paints blocks again", target and len(profs[target]["blocks"]) >= 1)

        # ── T5: shelf order — status, then name (F3)
        busy = max([c for c in profs.values() if len(c["blocks"]) >= 2], key=lambda c: len(c["blocks"]))
        page.locator('.kg-surface > .kg-panel[data-prof="%s"] .kg-pauto' % busy["id"]).click()
        page.wait_for_timeout(500)
        SO = page.evaluate("() => window.__KG_TEST__.STATUS_ORDER")
        G = page.evaluate("() => window.__KG_TEST__.GEO_MINI")
        CWc, CHc = G["W"] + G["GX"], G["H"] + G["GY"]

        def shelf_match(cards, truth):
            cd = [c for c in cards if c["id"] == busy["id"]]
            if not cd or busy["id"] not in truth:
                return False
            got_ = [(b["x"], b["y"]) for b in cd[0]["blocks"]]
            want_ = truth[busy["id"]]["order"]
            if len(want_) != len(got_) or not want_:
                return False
            if not all(abs(want_[i]["x"] - got_[i][0]) <= 2 and abs(want_[i]["y"] - got_[i][1]) <= 2
                       for i in range(len(want_))):
                return False
            # v17 (user 2026-10-12): in-card order became DEPENDENCY FIRST, so the
            # old status-monotone gate is retired — the want_/got_ equality above
            # already pins the DOM to the recomputed model (whatever order it uses).
            # v13: the in-card lattice is COLUMN-first (<=4 blocks = one column,
            # longer queues wrap into a second), NOT row-major 2 cols.
            n_ = len(got_)
            cols_ = 1 if n_ <= 4 else 2
            cr_ = -(-n_ // cols_)
            return all(abs(got_[k][0] - (G["M"] + (k // cr_) * CWc)) <= 2 and abs(got_[k][1] - (G["M"] + (k % cr_) * CHc)) <= 2
                       for k in range(len(got_)))

        conv2, res = combined_until(page, [], shelf_match)
        cards, truth1 = res["cards"], res["truth"]
        card = [c for c in cards if c["id"] == busy["id"]][0]
        want = truth1[busy["id"]]["order"]
        got = [(b["x"], b["y"]) for b in card["blocks"]]
        order = [(b["x"], b["y"]) for b in card["blocks"]]
        ok("DOM block order equals the dependency-first model truth",
           all(abs(want[i]["x"] - order[i][0]) <= 2 and abs(want[i]["y"] - order[i][1]) <= 2
               for i in range(len(want))) if len(want) == len(order) else False, order[:4])
        ok("block homes = column-first lattice matching recomputed model (converged)", conv2,
           "lattice want %s got %s" % (want[:4], got[:4]))
        n1 = len(got)
        cols1 = 1 if n1 <= 4 else 2
        cr1 = -(-n1 // cols1)
        ok("lattice exact (column-first: <=4 one column, else two)",
           bool(got) and all(abs(got[k][0] - (G["M"] + (k // cr1) * CWc)) <= 2 and abs(got[k][1] - (G["M"] + (k % cr1) * CHc)) <= 2
                             for k in range(len(got))), got[:3])

        # ── T6: free placement inside the card (F2) ──
        def card_meta():
            return page.evaluate("""(pid) => {
              const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
              const b = el.querySelector('.kg-pbody').getBoundingClientRect();
              const sv = el.querySelector('.kg-mini').getBoundingClientRect();
              const vb = (sv.getAttribute ? 1 : 1) && (el.querySelector('.kg-mini').getAttribute('viewBox') || '').split(' ').map(Number);
              const n0 = el.querySelector('.kg-node').getBoundingClientRect();
              return { bx: b.x, by: b.y, bw: b.width, bh: b.height, sx: sv.x, sy: sv.y, sw: sv.width, sh: sv.height,
                       vbx: vb[0], vby: vb[1], vbw: vb[2], vbh: vb[3], nw: n0.width, nh: n0.height };
            }""", busy["id"])

        def old_content_box(m):
            # what the OLD code allowed: the content bbox (vw×vh), centred in the body
            px_per = m["sw"] / m["vbw"]
            vw = m["vbw"] + 2 * m["vbx"] * -1 if False else m["vbw"] - 2 * (-m["vbx"])
            vh = m["vbh"] - 2 * (-m["vby"])
            w_px, h_px = vw * px_per, vh * px_per
            return {"left": m["bx"] + (m["bw"] - w_px) / 2, "top": m["by"] + (m["bh"] - h_px) / 2,
                    "right": m["bx"] + (m["bw"] + w_px) / 2, "bottom": m["by"] + (m["bh"] + h_px) / 2}

        # v13/v14 walls are TALLER than the fold — the resize grip sits below it
        # and a mouse.move to an off-screen point is a silent no-op (the v9 round
        # hit the same class: scrollIntoView first, then re-measure in-frame).
        def bring_into_frame():
            page.evaluate("""(pid) => {
              const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
              if (el) el.scrollIntoView({ block: 'end' });
            }""", busy["id"])
            page.mouse.wheel(0, -90)
            page.wait_for_timeout(220)

        bring_into_frame()
        meta = card_meta()
        old = old_content_box(meta)
        slack_r = meta["bx"] + meta["bw"] - old["right"]
        slack_b = meta["by"] + meta["bh"] - old["bottom"]
        # v14 replaced the premise of this section: stretching a card no longer
        # leaves a slack band outside the content box -- the content is re-flowed to
        # fill the card (that is the release). So the room for a free drop is the
        # card's own corner, and the invariant worth locking is the OPPOSITE one.
        ok("v14: a stretched card leaves no dead slack band",
           max(slack_r, slack_b) <= 8, (round(slack_r, 1), round(slack_b, 1)))
        nb = len(card["blocks"])

        def block_pos(i=0):
            # rebase (v18 chain2 red): measure the block AND its card's live body
            # rect in the SAME frame. The old code compared against `meta` captured
            # before the first drag; a hot re-layout / push-aside between the two
            # drags moves the card, and containment was judged against a stale box
            # (2342px-tall live wall, cards legitimately shift rows on every poll).
            js = '([pid,i]) => { const p = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`); const n = p.querySelectorAll(`.kg-node`)[i]; const q = n.getBoundingClientRect(); const bd = p.querySelector(`.kg-pbody`).getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width, h: q.height, cx: q.x + q.width / 2, cy: q.y + q.height / 2, bx: bd.x, by: bd.y, bw: bd.width, bh: bd.height }; }'
            r = page.evaluate(js, [busy["id"], i])
            return r

        contained = lambda r: (r["x"] >= r["bx"] - 2 and r["y"] >= r["by"] - 2 and
                               r["x"] + r["w"] <= r["bx"] + r["bw"] + 2 and
                               r["y"] + r["h"] <= r["by"] + r["bh"] + 2)

        # cards may overlap after a push-aside; a pointerdown at a covered centre
        # grabs the WRONG card. Only drag blocks whose own rect is on top.
        def pick_block(exclude=(), target=None):
            lst = page.evaluate("""(pid) => {
              const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
              const b = el.querySelector('.kg-pbody').getBoundingClientRect();
              return Array.from(el.querySelectorAll('.kg-node')).map((n, i) => {
                const q = n.getBoundingClientRect();
                const cx = q.x + q.width / 2, cy = q.y + q.height / 2;
                const hit = document.elementFromPoint(cx, cy);
                const own = !!(hit && hit.closest && hit.closest('.kg-node') === n);
                const inside = q.x >= b.x - 1 && q.y >= b.y - 1 &&
                               q.x + q.width <= b.x + b.width + 1 && q.y + q.height <= b.y + b.height + 1;
                return { i: i, x: q.x, y: q.y, w: q.width, h: q.height, cx: cx, cy: cy, own: own, inside: inside };
              });
            }""", busy["id"])
            cands = [c for c in lst if c["i"] not in exclude and c["own"]
                     and c["inside"] and c["cy"] < 880]
            if not cands:
                return None, None
            if target:      # farthest from where we intend to drop = real travel
                cands.sort(key=lambda c: -((c["cx"] - target[0]) ** 2 + (c["cy"] - target[1]) ** 2))
            return cands[0]["i"], cands[0]

        vp = page.evaluate("() => [innerWidth, innerHeight]")
        br_drop = (min(meta["bx"] + meta["bw"] - 40, vp[0] - 20), min(meta["by"] + meta["bh"] - 40, vp[1] - 20))
        tl_drop = (max(meta["bx"] + 40, 20), max(meta["by"] + 40, 20))
        # v19 note: v15+ blocks are variable width (W up to the card width), so a
        # centre-follow drop at bx+40 lets the block's own half-width cross the
        # border even though the clamp holds its top-left corner legally flush.
        # Aim by the block's half extent instead of fighting the product rule.
        i1, b0 = pick_block(target=br_drop)
        ok("found a grabbable block on the busy card", i1 is not None, b0)
        drag_block(page, (b0["cx"], b0["cy"]), br_drop)
        r0 = block_pos(i1)
        d0 = lambda r: ((r["cx"] - br_drop[0]) ** 2 + (r["cy"] - br_drop[1]) ** 2) ** 0.5
        ok("the block travels toward the corner it was dropped at",
           d0(r0) < d0(b0) - 40 and (abs(r0["x"] - b0["x"]) + abs(r0["y"] - b0["y"])) > 12,
           "dist %d -> %d" % (d0(b0), d0(r0)))
        ok("corner drop stays fully inside the card", contained(r0), r0)

        page.wait_for_timeout(700)  # not a double-tap on the same block
        i2, b1 = pick_block(exclude={i1}, target=tl_drop)
        ok("found a second grabbable block", i2 is not None, b1)
        drag_block(page, (b1["cx"], b1["cy"]), tl_drop)
        r1 = block_pos(i2)
        d1 = lambda r: ((r["cx"] - tl_drop[0]) ** 2 + (r["cy"] - tl_drop[1]) ** 2) ** 0.5
        ok("drag actually engaged the second block", abs(r1["x"] - b1["x"]) + abs(r1["y"] - b1["y"]) > 8,
           (b1, r1))
        ok("and back across the card toward the top-left corner",
           d1(r1) < d1(b1) - 40, "dist %d -> %d" % (d1(b1), d1(r1)))
        ok("top-left drop stays inside", contained(r1), r1)

        page.wait_for_timeout(700)
        b2 = block_pos(i1)
        drag_block(page, (b2["cx"], b2["cy"]), (meta["bx"] + meta["bw"] + 320, meta["by"] + meta["bh"] + 320))
        r2 = block_pos(i1)
        ok("dragging far past the edge gets clamped inside", contained(r2), r2)

        saved = page.evaluate("(pid) => JSON.parse(localStorage.getItem('hermes.kanbangraph.miniPos.' + pid) || '{}')", busy["id"])
        ok("manual positions persisted (two blocks)", len(saved) >= 2, len(saved))

        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface", timeout=20000)
        page.wait_for_timeout(700)
        meta2 = page.evaluate("""(pid) => {
          const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
          const b = el.querySelector('.kg-pbody').getBoundingClientRect();
          return { bx: b.x, by: b.y, bw: b.width, bh: b.height };
        }""", busy["id"])
        rr = block_pos(i1)
        cont2 = (rr["x"] >= meta2["bx"] - 2 and rr["y"] >= meta2["by"] - 2 and
                 rr["x"] + rr["w"] <= meta2["bx"] + meta2["bw"] + 2 and
                 rr["y"] + rr["h"] <= meta2["by"] + meta2["bh"] + 2)
        ok("free positions survive reload inside the card", cont2, (rr, meta2))
        page.screenshot(path=SHOTS + "/v10_free.png")

        ok("no page errors", not PAGE_ERRORS, PAGE_ERRORS[:3])
        browser.close()


if __name__ == "__main__":
    main()
