#!/usr/bin/env python
"""Headless acceptance for kanban-graph v15 (2026-10-12 round 2).

Asks this round (user): 任务块尽量占满卡片的宽度 — blocks must cover the
card WIDTH. Mechanism: height-fit-governed cards widen the BLOCK itself into
the leftover width (ktfEffGeo); width-governed cards keep the base lattice.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v15_hl.py
"""
import atexit
import json
import os
import statistics

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
    if (sessionStorage.getItem('__kgv15')) return;
    sessionStorage.setItem('__kgv15', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', '[]');
    localStorage.setItem(K + 'layout.__all__', '{}');
    localStorage.setItem(K + 'stripW.__all__', '{}');
    localStorage.setItem(K + 'maxed.__all__', '');
    var rm = [];
    for (var i = 0; i < localStorage.length; i++) {
      var lk = localStorage.key(i);
      if (lk && lk.indexOf(K + 'miniPos.') === 0) rm.push(lk);
    }
    rm.forEach(function (lk) { localStorage.removeItem(lk); });
  } catch (e) {}
})();
"""

# per busy card: body rect, per-block rect (viewport px), viewBox units
SURVEY = """() => {
  const out = [];
  document.querySelectorAll('.kg-surface > .kg-panel').forEach(p => {
    if (p.classList.contains('kg-pstrip')) return;
    const body = p.querySelector('.kg-pbody');
    const svg = p.querySelector('svg.kg-mini');
    const bs = Array.from(p.querySelectorAll('.kg-node')).map(g => {
      const r = g.getBoundingClientRect();
      const bp = g.querySelector('.kg-box');
      return { x: r.x, y: r.y, w: r.width, h: r.height,
               boxW: bp ? +bp.getAttribute('width') : null };
    });
    if (!body || !svg || !bs.length) return;
    const br = body.getBoundingClientRect();
    out.push({
      prof: p.getAttribute('data-prof'),
      bodyW: br.width, bodyH: br.height, bodyX: br.x,
      vb: (svg.getAttribute('viewBox') || '0 0 1 1').split(' ').map(Number),
      svgW: svg.getBoundingClientRect().width,
      blocks: bs
    });
  });
  return out;
}"""


def overlaps(a, b):
    return not (a["x"] + a["w"] <= b["x"] + 0.5 or b["x"] + b["w"] <= a["x"] + 0.5
                or a["y"] + a["h"] <= b["y"] + 0.5 or b["y"] + b["h"] <= a["y"] + 0.5)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE + "/kanban-graph", wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1400)

    cards = page.evaluate(SURVEY)
    ok("T0 busy cards exist on the real wall", len(cards) >= 3, len(cards))
    if not cards:
        raise SystemExit  # nothing to judge — early exit, no silent green

    fills, mids, thin, ov_pairs = [], [], [], []
    for c in cards:
        minx = min(b["x"] for b in c["blocks"])
        maxx = max(b["x"] + b["w"] for b in c["blocks"])
        span = maxx - minx
        fill = span / c["bodyW"]
        fills.append(fill)
        for b in c["blocks"]:
            if b["w"] < 200:
                thin.append("%s:%.0f" % (c["prof"], b["w"]))
        ws = sorted(b["w"] for b in c["blocks"])
        mids.append(statistics.median(ws))
        # per-card zero overlap among blocks
        for i in range(len(c["blocks"])):
            for j in range(i + 1, len(c["blocks"])):
                if overlaps(c["blocks"][i], c["blocks"][j]):
                    ov_pairs.append("%s#%d/%d" % (c["prof"], i, j))
    page.screenshot(path=SHOTS + "/v15_wall.png")

    # ── T1: width-fill contract ──
    ok("T1 every card's block span fills >=85% of the card width",
       min(fills) >= 0.85, "min=%.3f" % min(fills))
    # width-governed cards keep the 2M grid margin (that is the honest floor
    # of "fill"); the binding contract is NO big side margin like before v15
    # (real wall 2026-10-12 pre-fix: spans 53.6%, pads 95-168px).
    ok("T1b median fill >=86% (wall-wide)", statistics.median(fills) >= 0.86,
       "median=%.3f" % statistics.median(fills))
    bigpad = []
    for c in cards:
        minx = min(b["x"] for b in c["blocks"])
        maxx = max(b["x"] + b["w"] for b in c["blocks"])
        lp, rp = minx - c["bodyX"], c["bodyX"] + c["bodyW"] - maxx
        lim = 0.10 * c["bodyW"] + 8
        if max(lp, rp) > lim:
            bigpad.append("%s:%.0f>%.0f" % (c["prof"], max(lp, rp), lim))
    ok("T1c no card keeps a big side margin (>10%%+8px of the body)", not bigpad, bigpad[:5])
    # ── T2: blocks stayed big (v13/v14 floor is 200px) ──
    ok("T2 every visible block is >=200px wide", not thin, thin[:5])
    ok("T2b median block width >=222px", statistics.median(mids) >= 222,
       "median=%.1f" % statistics.median(mids))
    # ── T3: zero block overlap with miniPos cleared ──
    ok("T3 no blocks overlap inside a card", not ov_pairs, ov_pairs[:5])
    # ── T4: svg box never crosses the body box ──
    bad_box = []
    for c in cards:
        minx = min(b["x"] for b in c["blocks"])
        maxx = max(b["x"] + b["w"] for b in c["blocks"])
        body = page.evaluate(
            "(prof) => { const p = document.querySelector('[data-prof=\"' + CSS.escape(prof) + '\"] .kg-pbody');"
            " const r = p.getBoundingClientRect(); return { x: r.x, r: r.right }; }", c["prof"])
        if minx < body["x"] - 1 or maxx > body["r"] + 1:
            bad_box.append(c["prof"])
    ok("T4 block boxes stay inside the card body", not bad_box, bad_box[:5])

    # ── T5: reload survives (geometry is derived, nothing to persist) ──
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1400)
    cards2 = page.evaluate(SURVEY)
    fills2 = []
    for c in cards2:
        minx = min(b["x"] for b in c["blocks"])
        maxx = max(b["x"] + b["w"] for b in c["blocks"])
        fills2.append((maxx - minx) / c["bodyW"])
    ok("T5 fill survives a reload", fills2 and min(fills2) >= 0.85,
       "min=%.3f n=%d" % (min(fills2) if fills2 else -1, len(fills2)))

    # ── T6: source-truth cross-check — predicted per-block unit width equals
    #        the DOM box width (ktfEffGeo via __KG_TEST__, no hardcoded numbers)
    Tpred = page.evaluate("""() => {
      const out = [];
      const T = window.__KG_TEST__;
      document.querySelectorAll('.kg-surface > .kg-panel').forEach(p => {
        if (p.classList.contains('kg-pstrip')) return;
        const body = p.querySelector('.kg-pbody');
        const n = p.querySelectorAll('.kg-node').length;
        if (!body || !n) return;
        const cap = T.MINI_SCALE_MAX;
        const e = T.ktfEffGeo(n, body.clientWidth, body.clientHeight, cap);
        out.push({ prof: p.getAttribute('data-prof'), expectW: e.geo.W });
      });
      return out;
    }""")
    mismatch = []
    for c in cards2:
        pr = [t for t in Tpred if t["prof"] == c["prof"]]
        if not pr:
            mismatch.append(c["prof"] + " (no prediction)")
            continue
        bw = c["blocks"][0]["boxW"]
        if bw is None or abs(bw - pr[0]["expectW"]) > 0.5:
            mismatch.append("%s dom=%s want=%s" % (c["prof"], bw, pr[0]["expectW"]))
    ok("T6 rendered box width == ktfEffGeo prediction (same source)", not mismatch, mismatch[:5])

    # ── T7: drag a block in a widened card; after release it snaps on the
    #        NEW lattice and lands inside the card ──
    tgt = None
    for c in sorted(cards2, key=lambda z: -z["bodyW"]):
        if len(c["blocks"]) >= 1 and c["prof"]:
            tgt = c
            break
    drag_ok, drag_note = False, "no target"
    if tgt:
        handle = page.query_selector('[data-prof="%s"] .kg-node' % tgt["prof"])
        page.evaluate("(prof) => document.querySelector('[data-prof=\"' + CSS.escape(prof) + '\"]')"
                      ".scrollIntoView({ block: 'center' })", tgt["prof"])
        page.wait_for_timeout(250)
        hb = handle.bounding_box()
        if not hb:
            drag_note = "handle not visible"
        else:
            pre = page.evaluate("""(prof) => Array.from(
              document.querySelectorAll('[data-prof="' + CSS.escape(prof) + '"] .kg-node')
            ).map(g => { const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })""", tgt["prof"])
            src = {"x": hb["x"] + hb["width"] / 2, "y": hb["y"] + hb["height"] / 2}
            # move along the row only: the drop claims exactly ONE cell so the
            # rescue chain is space-adequate (0 overlap is provable, not luck)
            dst = {"x": src["x"] + 60, "y": src["y"]}
            page.mouse.move(src["x"], src["y"])
            page.mouse.down()
            page.mouse.move(src["x"] + 8, src["y"] + 8, steps=3)
            page.mouse.move(dst["x"], dst["y"], steps=6)
            page.mouse.up()
            page.wait_for_timeout(700)
            after = page.evaluate("""(prof) => {
              const p = document.querySelector('[data-prof="' + CSS.escape(prof) + '"]');
              const body = p.querySelector('.kg-pbody').getBoundingClientRect();
              const bs = Array.from(p.querySelectorAll('.kg-node')).map(g => {
                const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
              });
              return { body: { x: body.x, y: body.y, w: body.width, h: body.height }, blocks: bs };
            }""", tgt["prof"])
            inside = all(b["x"] >= after["body"]["x"] - 1 and b["x"] + b["w"] <= after["body"]["x"] + after["body"]["w"] + 1
                        and b["y"] >= after["body"]["y"] - 1 and b["y"] + b["h"] <= after["body"]["y"] + after["body"]["h"] + 1
                        for b in after["blocks"])
            # exactly the grabbed block moved: match pre-rects to after-rects
            moved = sum(1 for a in pre for b in after["blocks"]
                        if abs(b["x"] - a["x"]) + abs(b["y"] - a["y"]) > 4 and abs(b["x"] - a["x"]) < 200)
            ov2 = []
            bl = after["blocks"]
            for i in range(len(bl)):
                for j in range(i + 1, len(bl)):
                    if overlaps(bl[i], bl[j]):
                        ov2.append((i, j))
            # v21 contract (user 2026-10-13): only the grabbed block moves;
            # siblings keep their pre-drag rects; the drop lands at the pointer
            # (no collision hop). Overlap with a neighbour is now LEGAL.
            stayed = sum(1 for a, b in zip(pre, after["blocks"])
                         if abs(b["x"] - a["x"]) + abs(b["y"] - a["y"]) <= 1)
            drag_ok = inside and moved >= 1 and stayed == len(pre) - 1
            drag_note = "inside=%s moved=%s stayed=%s/%d overlap=%d(v21 legal)" % (inside, moved, stayed, len(pre), len(ov2))
    ok("T7 drag: only the grabbed block moves, siblings keep their spots", drag_ok, drag_note)

    # the drop must be persisted per profile (miniPos store) — non-vacuous:
    # T7 ran on a card and wrote exactly one override entry
    store_after = page.evaluate("""() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('hermes.kanbangraph.miniPos.') === 0) out[k.slice('hermes.kanbangraph.miniPos.'.length)] = JSON.parse(localStorage.getItem(k));
      }
      return out;
    }""")
    tot_ov = sum(len(v) for v in store_after.values())
    ok("T7b exactly one manual override persisted", tot_ov == 1, store_after)

    ok("T8 no page errors", not errs, errs[:3])

    # ── T9 (v15.1, rebased v19): wide-card column packing — pure geometry on
    # the live bundle. v19 moved M 12->6 and the cap 370->450, so W values are
    # read off the live constants instead of pinned snapshots (skill law: 现算).
    k = page.evaluate("""() => {
      const T = window.__KG_TEST__;
      const g = (n, w, h) => { const e = T.ktfEffGeo(n, w, h, T.MINI_SCALE_MAX);
        return { cols: e.cols, W: e.geo.W, ch: e.changed }; };
      const out = { a: g(2, 1599, 260), b: g(9, 1500, 426), c: g(4, 300, 500),
                    d: g(2, 1400, 100), e: g(1, 900, 300), cap: T.KTF_WIDE_MAX };
      return out;
    }""")
    ok("T9 wide cards pack columns (n=2@1599 -> cols2; n=9@1500 -> cols3)",
       k["a"]["cols"] == 2 and k["a"]["ch"] and k["b"]["cols"] == 3 and k["b"]["ch"],
       json.dumps(k))
    ok("T9b width-fit card untouched (cols1, unchanged)",
       k["c"]["cols"] == 1 and not k["c"]["ch"], k["c"])
    ok("T9c aspect guard holds against the LIVE cap (all W <= KTF_WIDE_MAX)",
       all(v["W"] <= k["cap"] for v in k.values() if isinstance(v, dict)), k["cap"])
    # v19 contract: a lone block in a wide card widens instead of leaving blanks
    ok("T9d single block in 900px card widens (W>168)",
       k["e"]["ch"] and k["e"]["W"] > 168, k["e"])
    page.screenshot(path=SHOTS + "/v15_wall_end.png")
    browser.close()
