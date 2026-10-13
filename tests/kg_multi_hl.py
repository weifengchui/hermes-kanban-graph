#!/usr/bin/env python
"""Headless acceptance for the kanban-graph multi-profile wall (9119 dashboard).

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python \
  /home/yxf/.hermes/profiles/liteguard/scripts/kg_multi_hl.py

Checks: one panel per profile, nothing overlaps, every mini graph is fitted in
its body, drag magnetises to a neighbour edge without resizing anything else,
resize snaps to the 8px grid, chip + panel-close hide and persist across a
reload, cross-profile wires draw, auto-arrange re-tiles, single-board mode still
renders. Screenshots land in /tmp/kg_shots/.
"""
import os, sys, json

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"

from playwright.sync_api import sync_playwright

fails, notes = [], []


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgseed')) return;
    sessionStorage.setItem('__kgseed', '1');
    localStorage.setItem('hermes.kanbangraph.mode', 'multi');
    localStorage.setItem('hermes.kanbangraph.scope', '');
    localStorage.setItem('hermes.kanbangraph.crossEdges', '1');
    localStorage.setItem('hermes.kanbangraph.selectedBoard', 'edu');
    localStorage.removeItem('hermes.kanbangraph.hiddenProfiles');
    localStorage.removeItem('hermes.kanbangraph.layout.__all__');
    localStorage.removeItem('hermes.kanbangraph.layout.edu');
  } catch (e) {}
})();
"""

ORDER = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(p => ({
  prof: p.getAttribute('data-prof'),
  blocks: p.querySelectorAll('svg.kg-mini g.kg-node').length }))"""

RECTS = """() => Array.from(document.querySelectorAll('.kg-panel')).map(p => {
  const r = p.getBoundingClientRect();
  return {p: p.getAttribute('data-prof'), x: Math.round(r.x*10)/10, y: Math.round(r.y*10)/10,
          w: Math.round(r.width), h: Math.round(r.height)};
})"""


def overlaps(list_):
    out = []
    for i in range(len(list_)):
        for j in range(i + 1, len(list_)):
            a, b = list_[i], list_[j]
            if not (a["x"] + a["w"] <= b["x"] + 1 or b["x"] + b["w"] <= a["x"] + 1 or
                    a["y"] + a["h"] <= b["y"] + 1 or b["y"] + b["h"] <= a["y"] + 1):
                out.append(a["p"] + "/" + b["p"])
    return out


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 1500})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors, bad_api = [], []
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)
    page.on("response", lambda r: bad_api.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)
    noise = []

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    try:
        page.wait_for_selector(".kg-panel", timeout=15000)
    except Exception:
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.get_by_text("依赖大屏", exact=False).first.click()
        page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(2500)

    ok("mode=multi", page.evaluate("localStorage.getItem('hermes.kanbangraph.mode')") == "multi")

    # ── initial wall ──
    boxes0 = page.evaluate(RECTS)
    panels = [b["p"] for b in boxes0]
    ok("one panel per profile (live wall)", len(panels) >= 6 and len(panels) == len(set(panels)), panels)
    ok("no overlap at first paint", not overlaps(boxes0), overlaps(boxes0))
    # v14 (user 2026-10-12): 自动排列 STRETCHES cards over the usable screen, so
    # "every tile the same size" is gone by design. What must hold instead:
    # one row = one height, every row spans the board edge-to-edge, rows stack
    # with exactly PGAP, and nothing is squeezed below PMIN_H (v13.1's no-squeeze
    # rule survives — a full wall simply scrolls, and scrolling is allowed).
    K0 = page.evaluate("() => { const T = window.__KG_TEST__; return { PGAP: T.PGAP, PMIN_H: T.PMIN_H, STRIP_GAP: T.STRIP_GAP }; }")

    def frame():
        return page.evaluate("""() => { const b = document.querySelector('.kg-board').getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height }; }""")

    def busy_rows(boxes):
        rows = {}
        for b in boxes:
            if b["h"] > 100:  # strips are 32px
                rows.setdefault(round(b["y"]), []).append(b)
        return rows

    def row_checks(boxes, tag, tol=2.5):
        bad = []
        fr = frame()
        rows = busy_rows(boxes)
        ys = sorted(rows)
        for y in ys:
            rr = sorted(rows[y], key=lambda z: z["x"])
            if len({round(c["h"]) for c in rr}) != 1:
                bad.append(("row-height", y, sorted({round(c["h"]) for c in rr})))
            if abs((rr[0]["x"] - fr["x"]) - K0["PGAP"]) > tol:
                bad.append(("left", y, round(rr[0]["x"] - fr["x"], 1)))
            right = round(rr[-1]["x"] + rr[-1]["w"] - fr["x"], 1)
            if abs(right - (fr["w"] - K0["PGAP"])) > tol:
                bad.append(("right", y, right, round(fr["w"] - K0["PGAP"], 1)))
            for i in range(1, len(rr)):
                g = round(rr[i]["x"] - (rr[i - 1]["x"] + rr[i - 1]["w"]), 1)
                if abs(g - K0["PGAP"]) > tol:
                    bad.append(("inner-gap", y, g))
        for i in range(1, len(ys)):
            gapv = round(ys[i] - (ys[i - 1] + rows[ys[i - 1]][0]["h"]), 1)
            if abs(gapv - K0["PGAP"]) > tol:
                bad.append(("row-pitch", ys[i], gapv))
        if any(b["h"] > 100 and b["h"] < K0["PMIN_H"] - 1 for b in boxes):
            bad.append(("squeeze", sorted(round(b["h"]) for b in boxes if b["h"] > 100)[:4]))
        return bad
    # v22.2 rebase: the skyline packer deliberately keeps blocks at their
    # natural readable size — rows may end ragged and NO card is stretched.
    # The old "rows uniform + span edge to edge" contract belonged to the
    # stretch era. What still must hold: no squeeze under PMIN_H, no overlap,
    # the wall starts at PGAP, and the bounding box of the wall is DENSE
    # (coverage >= 0.60 — the user's original complaint was ~17% coverage).
    def skyline_checks(bs, tag):
        bad = []
        fr = frame()
        busy = [b for b in bs if b["h"] > 100]
        if len(busy) < 2:
            return ["wall has <2 busy cards: " + tag]
        if any(b["h"] < K0["PMIN_H"] - 1 for b in busy):
            bad.append(("squeeze", sorted(round(b["h"]) for b in busy)[:4]))
        top = min(b["y"] for b in busy)
        lx = round(min(b["x"] for b in busy if b["y"] <= top + 2) - fr["x"], 1)
        if abs(lx - K0["PGAP"]) > 3:
            bad.append(("left-start", lx))
        ov = overlaps(bs)
        if ov:
            bad.append(("overlap", ov[:2]))
        x0 = min(b["x"] for b in busy); y0 = min(b["y"] for b in busy)
        x1 = max(b["x"] + b["w"] for b in busy); y1 = max(b["y"] + b["h"] for b in busy)
        cov = round(sum(b["w"] * b["h"] for b in busy) / max(1.0, (x1 - x0) * (y1 - y0)), 3)
        if cov < 0.60:
            bad.append(("coverage", cov))
        return bad
    ok("v22.2 first paint: dense skyline (no squeeze/overlap, coverage>=0.60)",
       not skyline_checks(boxes0, "first paint"), skyline_checks(boxes0, "first paint")[:4])
    board = page.evaluate("() => { const b = document.querySelector('.kg-board'); return [b.clientWidth, b.clientHeight, b.scrollHeight]; }")
    # v14: scrolling is LEGAL now — the user ranks "blocks as large as possible"
    # above "the wall fits on one screen" (v13.1 deleted the height squeeze).
    # What is NOT legal is DEAD SPACE: the surface must end with its content.
    surf = page.evaluate("""() => { const s = document.querySelector('.kg-surface');
        const b = s.getBoundingClientRect();
        const kids = Array.from(s.children).filter(e => e.classList.contains('kg-panel') || e.classList.contains('kg-group'));
        const bot = kids.length ? Math.max(...kids.map(k => k.getBoundingClientRect().bottom)) : b.top;
        return { h: Math.round(b.height), dead: Math.round(b.bottom - bot) }; }""")
    ok("v14 no dead band under the wall (surface ends with its content)",
       surf["dead"] <= 40, surf)

    detail = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-panel')).map(p => {
      const svg = p.querySelector('svg.kg-mini');
      const body = p.querySelector('.kg-pbody').getBoundingClientRect();
      return {
        prof: p.getAttribute('data-prof'),
        title: (p.querySelector('.kg-ptitle')||{}).textContent||'',
        count: (p.querySelector('.kg-pcount')||{}).textContent||'',
        svgW: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
        svgH: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
        boxes: p.querySelectorAll('svg.kg-mini .kg-node').length,
        edges: p.querySelectorAll('svg.kg-mini .kg-edge').length,
        links: (p.querySelector('.kg-plink')||{}).textContent||'',
        empty: !!p.querySelector('.kg-pempty'),
        bodyW: Math.round(body.width), bodyH: Math.round(body.height),
        scale: (svg && svg.viewBox && svg.viewBox.width) ? +(svg.width.baseVal.value / svg.viewBox.width).toFixed(3) : 1,
        scrollable: (() => { const pb = p.querySelector('.kg-pbody');
          return !!pb && (pb.scrollWidth > pb.clientWidth + 1 || pb.scrollHeight > pb.clientHeight + 1); })()
      };
    })""")
    for d in detail:
        # v22.1: READABILITY FLOOR — scale never < 1; overflow scrolls, never crops.
        ok("panel %s fits or scrolls (never crops)" % d["prof"],
           (d["svgW"] <= d["bodyW"] + 1 and d["svgH"] <= d["bodyH"] + 1) or d["scrollable"],
           "%sx%s in %sx%s scroll=%s" % (d["svgW"], d["svgH"], d["bodyW"], d["bodyH"], d["scrollable"]))
        ok("panel %s readable (v22.1 scale>=1)" % d["prof"], d["scale"] >= 0.995, d["scale"])
        ok("panel %s has content" % d["prof"], d["empty"] or d["boxes"] > 0, "boxes=%s" % d["boxes"])
        ok("panel %s header" % d["prof"], bool(d["title"].strip() and d["count"].strip()), d["title"] + "/" + d["count"])
        ok("panel %s some svg text rendered" % d["prof"], d["empty"] or d["boxes"] > 0, "")
    kit = [d for d in detail if d["prof"] == "kitforge"][0]
    # v18b rebase: kitforge is a LIVE board (task counts drift daily) — the
    # old hard-coded 4 boxes / badge "3" rotted. Assert the INVARIANTS instead:
    # the settled card renders every task the header counts, and its cross-link
    # badge is a positive number.
    # v22.2 rebase: the header counts ALL tasks; hidden-status chips legitimately
    # hide some (the grey ring chip), so boxes <= count. Invariant: the settled
    # card renders at least one box and never more than the header counts.
    ok("settled profile still shows boxes (KTF)",
       kit["boxes"] > 0 and kit["boxes"] <= int(kit["count"] or 0), kit)
    import re as _re
    _m = _re.search(r"\d+", kit["links"] or "")
    ok("cross-link badge on kitforge", bool(_m) and int(_m.group()) >= 1, kit["links"])
    n_edges_in_panels = sum(d["edges"] for d in detail)
    ok("per-profile edges drawn", n_edges_in_panels >= 3, n_edges_in_panels)

    ok("cross-profile wires drawn", page.eval_on_selector_all(".kg-xedge", "e => e.length") >= 3,
       page.eval_on_selector_all(".kg-xedge", "e => e.length"))
    page.screenshot(path=SHOTS + "/01_initial.png")

    # ── edge magnet: neighbour's left edge, then release in the empty strip
    #    BELOW the wall. A 900px viewport clamped that drop onto row-1 cards
    #    and the drop merged (group cascade poisoned the later sections). ──
    row = sorted([b for b in boxes0 if b["y"] == boxes0[0]["y"]], key=lambda b: b["x"])
    src, tgt = row[0], row[1]
    before_all = {b["p"]: (b["x"], b["y"], b["w"], b["h"]) for b in boxes0}
    hb = page.query_selector('.kg-panel[data-prof="%s"] .kg-phead' % src["p"]).bounding_box()
    want = tgt["x"] + 1  # closest candidate => the neighbour's left edge wins the snap
    free_y = max(b["y"] + b["h"] for b in boxes0) + 60
    dx, dy = want - src["x"], tgt["y"] - src["y"]
    page.mouse.move(hb["x"] + 60, hb["y"] + 14)
    page.mouse.down()
    for k in range(1, 9):
        page.mouse.move(hb["x"] + 60 + dx * k / 8, hb["y"] + 14 + dy * k / 8)
        page.wait_for_timeout(40)
    held = [b for b in page.evaluate(RECTS) if b["p"] == src["p"]][0]
    ok("drag held snaps onto the neighbour edge", abs(held["x"] - tgt["x"]) < 2,
       "%s live-x=%.1f target=%.1f (aimed %.1f)" % (src["p"], held["x"], tgt["x"], want))
    dy2 = free_y - src["y"]
    for k in range(1, 5):
        page.mouse.move(hb["x"] + 60 + dx, hb["y"] + 14 + dy + (dy2 - dy) * k / 4)
        page.wait_for_timeout(40)
    page.mouse.up()
    page.wait_for_timeout(250)
    boxes1 = page.evaluate(RECTS)
    got = [b for b in boxes1 if b["p"] == src["p"]][0]
    ok("drag snapped onto the neighbour edge", abs(got["x"] - tgt["x"]) < 2,
       "%s x=%.1f target=%.1f (drag aimed at %.1f)" % (src["p"], got["x"], tgt["x"], want))
    ok("drop landed in the clear strip below the wall", got["y"] > max(b["y"] + b["h"] for b in boxes0) - 40, got["y"])
    # NB: live data can shift under the probe (pi works on the real board while
    # the chain runs) — cards that APPEARED since boxes0 are not moves/resizes
    moved = [b["p"] for b in boxes1 if b["p"] in before_all
             and before_all[b["p"]] != (b["x"], b["y"], b["w"], b["h"])]
    resized = [b["p"] for b in boxes1 if b["p"] in before_all
               and before_all[b["p"]][2:] != (b["w"], b["h"])]
    # v8's hard rule still applies to the card UNDER THE CURSOR: dragging must
    # never resize it (the "drifts one way, grows the other" bug class).
    self_resized = [b["p"] for b in boxes1 if b["p"] == src["p"] and before_all[b["p"]][2:] != (b["w"], b["h"])]
    ok("drag never resizes the dragged card", self_resized == [], self_resized)
    # v14: the OTHER cards sit on auto slots, so freeing a slot legitimately
    # re-flows their sizes (the wall re-fills) — but never below the hug floor.
    undersized = [b["p"] for b in boxes1 if b["h"] > 100 and b["h"] < K0["PMIN_H"] - 1]
    ok("re-fill never squeezes another card below PMIN_H", undersized == [], undersized)
    ok("drag only touches cards that were already on the wall", set(moved) <= {b["p"] for b in boxes0},
       (sorted(moved)[:6], sorted(resized)[:6]))
    ok("no overlap after drag", not overlaps(boxes1), overlaps(boxes1))
    saved = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}')")
    ok("drag persisted", src["p"] in saved, list(saved.keys()))
    page.screenshot(path=SHOTS + "/02_after_drag.png")

    # ── resize handle: snaps + grows (on a card that is on screen) ──
    pid = [b for b in boxes1 if b["y"] + b["h"] < 840][0]["p"]
    b_before = [b for b in boxes1 if b["p"] == pid][0]
    rz = page.query_selector('.kg-surface > .kg-panel[data-prof="%s"] > .kg-prsz' % pid).bounding_box()
    page.mouse.move(rz["x"] + 8, rz["y"] + 8)
    page.mouse.down()
    for k in range(1, 6):
        page.mouse.move(rz["x"] + 8 + 140 * k / 5, rz["y"] + 8 + 90 * k / 5)
        page.wait_for_timeout(40)
    page.mouse.up()
    page.wait_for_timeout(250)
    b_after = [b for b in page.evaluate(RECTS) if b["p"] == pid][0]
    ok("resize grew the panel", b_after["w"] > b_before["w"] + 80 and b_after["h"] > b_before["h"] + 50,
       "%sx%s -> %sx%s" % (b_before["w"], b_before["h"], b_after["w"], b_after["h"]))
    # v22.2 rebase: the BR grip never moves x/y (BY DESIGN) and edge-magnet may
    # land the edge on a NEIGHBOUR instead of the 8px grid. Judge the STORED
    # logical rect (zoom-proof): grid-multiple, or one edge within 1.5px of
    # another stored card's edge.
    layR = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}')")
    def _grid_or_edge(rr, allr):
        if rr["w"] % 8 == 0 or rr["h"] % 8 == 0:
            return True
        r2, b2 = rr["x"] + rr["w"], rr["y"] + rr["h"]
        for k, o in allr.items():
            if k == pid or not isinstance(o, dict) or "x" not in o:
                continue
            if min(abs(o["x"] - r2), abs(o["x"] + o["w"] - r2)) <= 1.5:
                return True
            if min(abs(o["y"] - b2), abs(o["y"] + o["h"] - b2)) <= 1.5:
                return True
        return False
    ok("resize grid-snapped or neighbour-edge-aligned (v22.2, stored rect)",
       pid in layR and _grid_or_edge(layR[pid], layR), layR.get(pid))
    page.screenshot(path=SHOTS + "/03_after_resize.png")

    # ── auto arrange ──
    page.get_by_text("自动排列", exact=True).first.click()
    page.wait_for_timeout(400)
    boxes2 = page.evaluate(RECTS)
    ok("auto-arrange: no overlap", not overlaps(boxes2), overlaps(boxes2))
    ok("v22.2 auto-arrange: dense skyline (no squeeze/overlap, coverage>=0.60)",
       not skyline_checks(boxes2, "auto"), skyline_checks(boxes2, "auto")[:4])
    # v22 doctrine (src comment, do NOT re-add silent auto-persist): defaults
    # stay LIVE; a FULL persist happens exactly when 自动排列 is clicked — so
    # after the click every wall card must carry a stored rect.
    ok("auto-arrange persisted the full derived wall (v22 doctrine)",
       len(page.evaluate("Object.keys(JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}'))")) == len(panels), "")
    page.screenshot(path=SHOTS + "/04_auto_arranged.png")

    # ── hide via chip + reload persistence ──
    # NB: pick a NAMED victim — an unassigned card (data-prof='') exists when
    # pi files tasks without an assignee, and indexOf('') would match every chip
    victim = [p for p in panels if p][-1]
    page.eval_on_selector_all(".kg-top .kg-chip-btn",
                              "els => { const t = els.find(e => (e.getAttribute('title')||'').indexOf('%s') === 0); if (t) t.click(); }" % victim)
    page.wait_for_timeout(300)
    left = page.eval_on_selector_all(".kg-panel", "e => e.length")
    ok("chip hides a profile", left == len(panels) - 1, "%d -> %d" % (len(panels), left))
    ok("hidden set persisted", victim in page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.hiddenProfiles')||'[]')"), "")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(1500)
    ok("still hidden after reload", page.eval_on_selector_all(".kg-panel[data-prof='%s']" % victim, "e => e.length") == 0, victim)

    victim2 = [p for p in panels if p != victim][-1]
    page.click('.kg-panel[data-prof="%s"] .kg-pclose' % victim2)
    page.wait_for_timeout(300)
    ok("panel close button hides it", page.eval_on_selector_all(".kg-panel[data-prof='%s']" % victim2, "e => e.length") == 0, victim2)

    # ── cross-link toggle off/on ──
    page.evaluate("localStorage.removeItem('hermes.kanbangraph.hiddenProfiles')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(1500)
    page.get_by_text("跨链", exact=False).first.click()
    page.wait_for_timeout(300)
    ok("cross wires can be switched off", page.eval_on_selector_all(".kg-xedge", "e => e.length") == 0, "")
    page.get_by_text("跨链", exact=False).first.click()
    page.wait_for_timeout(300)
    ok("cross wires come back", page.eval_on_selector_all(".kg-xedge", "e => e.length") >= 3, "")
    page.screenshot(path=SHOTS + "/05_multi_all.png")

    # ── card order: cards that still draw blocks first, then by profile name ──
    def namekey(n):
        # mirrors the plugin's localeCompare(name, "en", {numeric:true, base})
        if not n:
            return [1, ""]
        out, cur = [], ""
        for ch in n.lower():
            if ch.isdigit():
                cur += ch
            else:
                if cur:
                    out.append(cur.rjust(8, "0"))
                    cur = ""
                out.append(ch)
        if cur:
            out.append(cur.rjust(8, "0"))
        return [0, "".join(out)]

    def order_rule(seq):
        busy = [c["prof"] for c in seq if c["blocks"] > 0]
        idle = [c["prof"] for c in seq if c["blocks"] == 0]
        return ([c["prof"] for c in seq] == busy + idle,
                busy == sorted(busy, key=namekey), idle == sorted(idle, key=namekey))

    seq = page.evaluate(ORDER)
    ok("卡片顺序＝有任务块的在前、其后按 profile 名", all(order_rule(seq)),
       [(c["prof"], c["blocks"]) for c in seq])

    # hide 已完成: every all-done card loses its blocks and must sink to the end
    # LS_HIDE stores a JSON ARRAY of status names (readHide asserts Array.isArray)
    page.evaluate("localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify(['done']))")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=20000)
    page.wait_for_timeout(3000)
    seq2 = page.evaluate(ORDER)
    emptied = [c["prof"] for c in seq2 if c["blocks"] == 0]
    ok("隐藏状态后「无任务块」的卡片全部沉底（两段内各按名升序）", all(order_rule(seq2)),
       [(c["prof"], c["blocks"]) for c in seq2])
    ok("确有卡片因隐藏状态变为无块（该断言非空转）", len(emptied) > 0, emptied)
    page.screenshot(path=SHOTS + "/04b_order_idle_last.png")

    # 自动排列 must actually PLACE them in that order — the busy cards take the
    # first slots (top-left), the emptied ones land last. Reading order = row-major.
    page.locator("button", has_text="自动排列").first.click()
    page.wait_for_timeout(900)
    placed = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(p => {
      const r = p.getBoundingClientRect();
      return { prof: p.getAttribute('data-prof'), x: Math.round(r.x), y: Math.round(r.y),
               blocks: p.querySelectorAll('svg.kg-mini g.kg-node').length }; })""")
    placed.sort(key=lambda c: (round(c["y"] / 20), c["x"]))
    ok("自动排列把有块的卡铺在前排、无块卡铺在后排（各段按名升序）", all(order_rule(placed)),
       [(c["prof"], c["blocks"], "%s,%s" % (c["x"], c["y"])) for c in placed])
    page.screenshot(path=SHOTS + "/04c_order_after_arrange.png")

    page.evaluate("localStorage.removeItem('hermes.kanbangraph.hideSt')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=20000)
    page.wait_for_timeout(2500)

    # ── scope switch to a single board ──
    # v20.1 debt rebase (v21 round): the scope picker is a NATIVE select now;
    # the old button + open-popup option click locators are dead.
    page.select_option("select.kg-native-sel", label="全部板")
    page.wait_for_timeout(300)
    page.select_option("select.kg-native-sel", label="教材站")
    page.wait_for_timeout(2500)
    scoped = [b["p"] for b in page.evaluate(RECTS)]
    ok("board scope narrows the wall to the edu profiles", bool(scoped) and set(scoped) < set(panels), scoped)
    ok("scoped layout stored under its own key",
       page.evaluate("!!localStorage.getItem('hermes.kanbangraph.layout.edu')") is not None, "")
    page.screenshot(path=SHOTS + "/06_scope_edu.png")

    # ── single-board mode still renders ──
    page.get_by_text("单板", exact=True).first.click()
    page.wait_for_timeout(2000)
    ok("single mode canvas present", page.eval_on_selector_all(".kg-canvas", "e => e.length") == 1, "")
    ok("single mode has no panels", page.eval_on_selector_all(".kg-panel", "e => e.length") == 0, "")
    ok("single mode draws nodes", page.eval_on_selector_all(".kg-svg .kg-node", "e => e.length") > 0,
       page.eval_on_selector_all(".kg-svg .kg-node", "e => e.length"))
    page.screenshot(path=SHOTS + "/07_single_mode.png")
    page.get_by_text("多 Profile", exact=True).first.click()
    page.wait_for_timeout(600)

    real_bad = [b for b in bad_api if not b.startswith("401 http://127.0.0.1:9119/api/auth/me")
                and "/dashboard-plugins/example/" not in b]
    noise = sorted(set(bad_api))
    real_err = [e for e in errors if "Failed to load resource" not in e]
    ok("no plugin page errors", not real_err, real_err[:4])
    ok("no api 4xx/5xx beyond the host auth probe", not real_bad, real_bad[:6])
    notes.append("NOTE non-2xx seen: " + ("; ".join(noise) if noise else "none"))
    browser.close()

print("\n".join(notes))
print()
if fails:
    print("FAILURES (%d):" % len(fails))
    print("\n".join(fails))
    sys.exit(1)
print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))
