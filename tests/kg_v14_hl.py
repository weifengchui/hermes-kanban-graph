#!/usr/bin/env python
"""Headless acceptance for kanban-graph v14 (2026-10-12).

User ask this round:
  1 点击「自动排列」-> 卡片尽可能铺满整个屏幕可用空间
  2 卡片里的任务块 -> 尽可能铺满卡片
  目的: 尽可能让用户看清文字信息

Everything is measured from the LIVE wall and compared against the engine's own
constants (window.__KG_TEST__) — no baked-in pixel snapshots (this machine's data
grows between runs, so absolute counts/lists always go stale).

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v14_hl.py
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
    if (sessionStorage.getItem('__kgv14')) return;
    sessionStorage.setItem('__kgv14', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', '[]');
    localStorage.setItem(K + 'layout.__all__', '{}');
    localStorage.setItem(K + 'stripW.__all__', '{}');
    localStorage.setItem(K + 'maxed.__all__', '');
    localStorage.setItem(K + 'hiddenProfiles', '[]');
    var rm = [];
    for (var i = 0; i < localStorage.length; i++) {
      var lk = localStorage.key(i);
      if (lk && lk.indexOf(K + 'miniPos.') === 0) rm.push(lk);
    }
    rm.forEach(function (lk) { localStorage.removeItem(lk); });
  } catch (e) {}
})();
"""

# card + its drawing area + every block + a rendered title height, all in one
# frame (viewport coords — every comparison below is viewport-to-viewport)
SURVEY = """() => {
  const board = document.querySelector('.kg-board').getBoundingClientRect();
  const cards = Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(el => {
    const b = el.getBoundingClientRect();
    const mini = el.querySelector('.kg-mini');
    const mb = mini ? mini.getBoundingClientRect() : null;
    const vb = mini ? String(mini.getAttribute('viewBox') || '').split(' ').map(Number) : null;
    const blocks = Array.from(el.querySelectorAll('.kg-node')).map(g => {
      const q = g.getBoundingClientRect();
      const t = g.querySelector('text');
      const tb = t ? t.getBoundingClientRect() : null;
      return { x: q.x, y: q.y, w: q.width, h: q.height, th: tb ? tb.height : 0 };
    });
    return {
      prof: el.getAttribute('data-prof'),
      strip: el.classList.contains('kg-pstrip'),
      x: b.x, y: b.y, w: b.width, h: b.height,
      mx: mb ? mb.x : 0, my: mb ? mb.y : 0, mw: mb ? mb.width : 0, mh: mb ? mb.height : 0,
      vb: vb && vb.length === 4 ? vb : null,
      blocks: blocks
    };
  });
  return { board: { x: board.x, y: board.y, w: board.width, h: board.height }, cards: cards };
}"""


def overlaps(a, b):
    return not (a["x"] + a["w"] <= b["x"] + 0.5 or b["x"] + b["w"] <= a["x"] + 0.5
                or a["y"] + a["h"] <= b["y"] + 0.5 or b["y"] + b["h"] <= a["y"] + 0.5)


def rows_of(cards):
    rows = {}
    for c in cards:
        rows.setdefault(round(c["y"]), []).append(c)
    return rows


def span_check(cards, board, pgap, tol=3.0):
    bad = []
    for y, rr in rows_of(cards).items():
        rr.sort(key=lambda z: z["x"])
        right = round(rr[-1]["x"] + rr[-1]["w"] - board["x"], 1)
        want = round(board["w"] - pgap, 1)
        if abs(right - want) > tol:
            bad.append((y, right, want))
        leftv = round(rr[0]["x"] - board["x"], 1)
        if abs(leftv - pgap) > tol:
            bad.append((y, "left", leftv, pgap))
    return bad


def click_auto(page):
    btn = None
    for b in page.query_selector_all("button"):
        t = (b.inner_text() or "").strip()
        if t == "自动排列" and b.bounding_box():
            bb = b.bounding_box()
            if bb["y"] < 220:      # toolbar button, not a card-head button
                btn = b
                break
    if btn:
        btn.click()
        page.wait_for_timeout(900)
    return btn is not None


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    errs = []
    page = ctx.new_page()
    page.add_init_script(SEED)
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE + "/kanban-graph", wait_until="networkidle")
    page.evaluate(SEED)
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1200)

    K = page.evaluate("""() => { const T = window.__KG_TEST__;
        return { PGAP: T.PGAP, PMIN_H: T.PMIN_H, GRID: T.GRID, M: T.GEO_MINI.M, CAP: T.MINI_SCALE_MAX,
                 BW: T.GEO_MINI.W, BH: T.GEO_MINI.H }; }""")
    ok("constants reachable (engine exposed for tests)", bool(K["PGAP"]) and bool(K["PMIN_H"]), K)

    # ── A. the default (unstored) wall and 自动排列 share ONE engine — so the
    # first paint must already fill the board, and clicking only persists it.
    # (The old witness compared "filled" against "filled" and read +0%.)
    before = page.evaluate(SURVEY)
    busy_before = [c for c in before["cards"] if not c["strip"] and c["blocks"]]
    ok("A 首屏（未落盘默认）已铺满板宽", not span_check(busy_before, before["board"], K["PGAP"]),
       span_check(busy_before, before["board"], K["PGAP"])[:3])
    area_before = sum(c["w"] * c["h"] for c in busy_before)

    ok("toolbar 自动排列 found", click_auto(page))
    sur = page.evaluate(SURVEY)
    board = sur["board"]
    cards = sur["cards"]
    busy = [c for c in cards if not c["strip"] and c["blocks"]]
    strips = [c for c in cards if c["strip"]]
    page.screenshot(path=SHOTS + "/v14_after_auto.png")

    ok("busy cards exist (non-vacuous)", len(busy) >= 3, len(busy))
    area_after = sum(c["w"] * c["h"] for c in busy)
    ok("A 自动排列与默认同一口径（面积不缩水）", area_after >= area_before - 1,
       "%d -> %d" % (area_before, area_after))

    # ── B. T1: cards fill the usable SCREEN width, row by row ──
    bad = span_check(busy, board, K["PGAP"])
    ok("T1 every busy row spans the board edge-to-edge", not bad, bad[:4])
    ys = sorted(rows_of(busy))
    pitch = [round(ys[i + 1] - (ys[i] + rows_of(busy)[ys[i]][0]["h"]), 1) for i in range(len(ys) - 1)]
    ok("T1 rows stack with exactly PGAP (no dead bands)", all(abs(p - K["PGAP"]) <= 2 for p in pitch), pitch[:5])

    # ── C. T2: blocks fill their CARD. The honest denominator is the MODEL box
    # (grid + the lattice's own M margin on both sides) — comparing the bare
    # block union to the card under-reads it by exactly that margin (168/192 =
    # 0.875 for a one-column card, which is a FULL fill, not a 12% hole).
    # A card whose scale is pinned at MINI_SCALE_MAX is exempt on purpose: the
    # leftover there is the single-block-in-a-giant-row guard doing its job.
    worst, thin, oob, capped, badscale = [], [], [], [], []
    for c in busy:
        if c["mw"] <= 0 or c["mh"] <= 0 or not c["vb"] or not c["vb"][2] or not c["vb"][3]:
            worst.append((c["prof"], "no-mini/viewBox"))
            continue
        ppu_x = c["mw"] / c["vb"][2]
        ppu_y = c["mh"] / c["vb"][3]
        if ppu_x > K["CAP"] + 0.01 or ppu_y > K["CAP"] + 0.01:
            badscale.append((c["prof"], round(max(ppu_x, ppu_y), 3), K["CAP"]))
        gw = max(b["x"] + b["w"] for b in c["blocks"]) - min(b["x"] for b in c["blocks"])
        gh = max(b["y"] + b["h"] for b in c["blocks"]) - min(b["y"] for b in c["blocks"])
        model_w = gw + 2 * K["M"] * ppu_x
        model_h = gh + 2 * K["M"] * ppu_y
        fill = max(model_w / c["mw"], model_h / c["mh"])
        near_cap = max(ppu_x, ppu_y) >= K["CAP"] - 0.01
        if near_cap:
            capped.append((c["prof"], round(fill, 3)))
        worst.append((c["prof"], round(fill, 3), near_cap))
        if fill < 0.95 and not near_cap:
            thin.append((c["prof"], round(fill, 3), int(c["mw"]), int(c["mh"]), len(c["blocks"])))
        for b in c["blocks"]:
            if b["x"] < c["mx"] - 2 or b["y"] < c["my"] - 2 or b["x"] + b["w"] > c["mx"] + c["mw"] + 2 or b["y"] + b["h"] > c["my"] + c["mh"] + 2:
                oob.append((c["prof"], round(b["x"]), round(b["y"])))
    ok("T2 every (non-capped) card's grid+margin box fills >=95% of the card", not thin, thin[:5])
    ok("T2 blocks never escape the card", not oob, oob[:4])
    ok("T2 the fit scale never exceeds MINI_SCALE_MAX", not badscale, badscale[:3])
    fills = [f for _, f, _c in worst if isinstance(f, float)]
    ok("T2 fill ratios + cap-pinned cards reported (min/median/max, capped)",
       bool(fills), (round(min(fills), 3), round(statistics.median(fills), 3), round(max(fills), 3), capped[:4]))

    # ── D. T3: the actual GOAL — readable text and readable blocks ──
    allb = [b for c in busy for b in c["blocks"]]
    thinw = [b for b in allb if b["w"] < 200]
    ok("T3 every visible block is >=200px wide", not thinw,
       (round(min([b["w"] for b in allb]), 1) if allb else "-", len(allb)))
    ths = [b["th"] for b in allb if b["th"] > 0]
    ok("T3 title text renders >=13px tall (readability floor)", bool(ths) and min(ths) >= 13,
       (round(min(ths), 1), round(statistics.median(ths), 1), round(max(ths), 1)) if ths else "no text")
    ok("T3 median title text >=16px (fill actually paid off)", bool(ths) and statistics.median(ths) >= 16,
       round(statistics.median(ths), 1) if ths else "no text")

    # ── E. T4: nothing squeezed, nothing overlapping ──
    boxes = [c for c in cards if c["w"] > 0 and c["h"] > 0]
    bad2 = 0
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if overlaps(boxes[i], boxes[j]):
                bad2 += 1
    ok("T4 zero overlap on the whole wall", bad2 == 0, bad2)
    ok("T4 no card squeezed below PMIN_H",
       all(c["h"] >= K["PMIN_H"] - 1 for c in busy), sorted(round(c["h"]) for c in busy)[:5])

    # ── F. T5: the stored layout really holds the stretched rects (persist) ──
    lay = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}')")
    spot = None
    for c in busy:
        r = lay.get(c["prof"])
        if r:
            spot = (c["prof"], round(r["w"], 1), round(c["w"], 1), round(r["h"], 1), round(c["h"], 1))
            break
    ok("T5 stretched rect persisted (surface w == painted w)",
       bool(spot) and abs(spot[1] - spot[2]) <= 2 and abs(spot[3] - spot[4]) <= 2, spot)
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1200)
    sur2 = page.evaluate(SURVEY)
    busy2 = [c for c in sur2["cards"] if not c["strip"] and c["blocks"]]
    bad3 = span_check(busy2, sur2["board"], K["PGAP"])
    ok("T5 fill survives a reload", not bad3, bad3[:3])

    # ── G. T6: ROOMY wall — hide most profiles, the remaining cards must reach
    #    the bottom of the usable screen (no dead band under them) ──
    guard = 0
    while guard < 40:
        guard += 1
        vis = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel'))
              .filter(e => !e.classList.contains('kg-pstrip')).length""")
        if vis <= 3:
            break
        hid = None
        for b in page.query_selector_all(".kg-chip-btn"):
            t = b.get_attribute("title") or ""
            if "点击隐藏" in t:
                hid = b
                break
        if hid is None:
            break
        hid.click()
        page.wait_for_timeout(260)
    vis = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel'))
          .filter(e => !e.classList.contains('kg-pstrip')).length""")
    ok("T6 缩到少卡场景可用（可见忙卡<=3）", vis <= 3, vis)
    ok("T6 自动排列 (roomy wall) clicked", click_auto(page))
    sur3 = page.evaluate(SURVEY)
    busy3 = [c for c in sur3["cards"] if not c["strip"] and c["blocks"]]
    strips3 = [c for c in sur3["cards"] if c["strip"]]
    content = busy3 + strips3
    bottom = max((c["y"] + c["h"] for c in content), default=0)
    slack = round(sur3["board"]["y"] + sur3["board"]["h"] - bottom, 1)
    ok("T6 roomy wall fills the screen height (no dead band at the bottom)",
       -2 <= slack <= 24, (slack, len(content)))
    bad4 = span_check(busy3, sur3["board"], K["PGAP"])
    ok("T6 roomy rows still span the board", not bad4, bad4[:3])
    ths3 = [b["th"] for c in busy3 for b in c["blocks"] if b["th"] > 0]
    ok("T6 roomy wall grows the text further (median >= 18px)",
       bool(ths3) and statistics.median(ths3) >= 18,
       (round(statistics.median(ths3), 1) if ths3 else "no text", len(ths3)))
    page.screenshot(path=SHOTS + "/v14_roomy_fill.png")

    ok("no page errors", not errs, errs[:3])
