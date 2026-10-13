#!/usr/bin/env python
"""Measure SVG text overflow inside kanban-graph nodes (mini panels + main canvas)."""
import json, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:9119"
SEED = """
(function(){try{
 if(sessionStorage.getItem('__probe'))return; sessionStorage.setItem('__probe','1');
 localStorage.setItem('hermes.kanbangraph.mode','multi');
 localStorage.setItem('hermes.kanbangraph.scope','');
 localStorage.setItem('hermes.kanbangraph.selectedBoard','edu');
 localStorage.setItem('hermes.kanbangraph.crossEdges','1');
 localStorage.removeItem('hermes.kanbangraph.hiddenProfiles');
 localStorage.removeItem('hermes.kanbangraph.layout.__all__');
}catch(e){}})();
"""
PROBE = """(sel) => {
  const out = [];
  document.querySelectorAll(sel).forEach(g => {
    const rect = g.querySelector('rect.kg-box').getBBox ? g.querySelector('rect.kg-box') : null;
    const box = { w: +rect.getAttribute('width'), h: +rect.getAttribute('height') };
    const rep = { box: box, parts: {} };
    ['kg-title','kg-asg','kg-st'].forEach(cls => {
      const t = g.querySelector('text.' + cls);
      if (!t) return;
      const b = t.getBBox();
      rep.parts[cls] = { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                         right: +(b.x + b.width).toFixed(1), bottom: +(b.y + b.height).toFixed(1) };
    });
    out.push(rep);
  });
  return out;
}"""

with sync_playwright() as pw:
    br = pw.chromium.launch(); ctx = br.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(SEED); pg = ctx.new_page()
    pg.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    pg.wait_for_selector(".kg-panel", timeout=15000); pg.wait_for_timeout(2500)

    mini = pg.evaluate(PROBE, "svg.kg-mini g.kg-node")
    W = pg.evaluate("() => +document.querySelector('svg.kg-mini g.kg-node rect.kg-box').getAttribute('width')")
    H = pg.evaluate("() => +document.querySelector('svg.kg-mini g.kg-node rect.kg-box').getAttribute('height')")
    print("mini node box: %sx%s  (nodes sampled: %d)" % (W, H, len(mini)))
    worst = []
    for r in mini:
        # v15: block width is PER CARD now (widened lattice) — compare each
        # node against its OWN box width, never the first-card constant.
        BW, BH = r["box"]["w"], r["box"]["h"]
        for cls, p in r["parts"].items():
            over_r = p["right"] - BW
            over_b = p["bottom"] - BH
            if over_r > -1 or over_b > -1:
                worst.append((cls, p["right"], p["bottom"], over_r, over_b, BW))
    if worst:
        print("MINI OVERFLOW:", json.dumps(worst[:12]))
    else:
        print("MINI: no text crosses the box border")
    widths = sorted({r["box"]["w"] for r in mini})
    worst_r = max((p["parts"]["kg-title"]["right"] for p in mini if "kg-title" in p["parts"]), default=0)
    worst_b = max((p["parts"]["kg-asg"]["bottom"] for p in mini if "kg-asg" in p["parts"]), default=0)
    # per-node title fill vs its own box: report the MEDIAN of maxima (v15: a
    # wide box with a short title is not an overflow, it is breathing room)
    fills = [p["parts"]["kg-title"]["right"] / p["box"]["w"] for p in mini if "kg-title" in p["parts"]]
    import statistics
    print("boxes seen: %s | widest title right edge=%.1f | lowest meta bottom=%.1f (box H %s) | title fill (per-node, median/max)=%.0f%%/%.0f%%"
          % (",".join(str(w) for w in widths), worst_r, worst_b, H,
             100 * (statistics.median(fills) if fills else 0), 100 * (max(fills) if fills else 0)))

    scales = pg.evaluate("""() => Array.from(document.querySelectorAll('svg.kg-mini')).map(s => {
      const vb = s.getAttribute('viewBox').split(' ').map(Number);
      return { vb: [vb[2], vb[3]], px: [Math.round(s.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().height)],
               scale: +(s.getBoundingClientRect().width / vb[2]).toFixed(2) };
    })""")
    print("mini scales:", json.dumps(scales))

    # main canvas
    pg.get_by_text("单板", exact=True).first.click()
    pg.wait_for_timeout(2200)
    main = pg.evaluate(PROBE, "svg.kg-svg g.kg-node")
    MW = pg.evaluate("() => +document.querySelector('svg.kg-svg g.kg-node rect.kg-box').getAttribute('width')")
    MH = pg.evaluate("() => +document.querySelector('svg.kg-svg g.kg-node rect.kg-box').getAttribute('height')")
    bad = []
    for r in main:
        for cls, p in r["parts"].items():
            if p["right"] - MW > -1 or p["bottom"] - MH > -1:
                bad.append((cls, p["right"], p["bottom"]))
    print("main node box: %sx%s nodes=%d" % (MW, MH, len(main)))
    print("MAIN OVERFLOW:", json.dumps(bad[:12])) if bad else print("MAIN: no text crosses box borders")
    mt = max((p["parts"]["kg-title"]["right"] for p in main if "kg-title" in p["parts"]), default=0)
    print("main widest title right=%.1f (box %s) fill=%.0f%%" % (mt, MW, 100.0 * mt / MW))
    br.close()
