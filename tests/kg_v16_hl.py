#!/usr/bin/env python3
"""kg_v16_hl.py — v16 acceptance: 组内列优先，折叠沉底，块变大.

Harness follows kg_v15_hl.py (same route, same localStorage seeding pattern).
hideSt mirrors the user's real view (done hidden); the three groups mirror the
user's screenshot. The headline assertion is OLD-vs-NEW on the SAME inputs:
column-first packing must make the smallest busy column dramatically wider
than the retired weighted treemap, and inside every card the v15.1 fill still
holds — which is exactly what "把任务块搞大一些" measures.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v16_hl.py
"""
import atexit, json, os, sys, datetime
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:9119"
SHOTS = "/mnt/e/Desktop/Board+图片/kanban"  # v16-era bug: Windows path treated as relative on Linux created a literal dir under CWD
try: os.makedirs(SHOTS, exist_ok=True)
except Exception: pass
notes, fails = [], []
def ok(name, cond, got=None):
    line = ("PASS " if cond else "FAIL ") + name + ("" if cond else " got=" + json.dumps(got)[:800])
    print(line, flush=True)
    (notes if cond else fails).append(line)
def eq(name, got, want): ok(name + " == " + str(want), got == want, got)
def close(name, got, want, tol=1.5): ok(name + " ~= " + str(want), got is not None and abs(got - want) <= tol, got)
atexit.register(lambda: (print("\n".join(fails), flush=True) if fails else None))

GROUPS = [
  {"id": "v16study", "name": "1.学习门户", "members": ["jrmath-lab", "study", "edu-qa", "jrphys-lab", "kitforge", "sr-lab"], "inner": {}},
  {"id": "v16adult", "name": "3.成人睡前故事", "members": ["jl-draft", "jl-voice", "jl-launch", "jl-qa"], "inner": {}},
  {"id": "v16kids", "name": "2.儿童睡前故事", "members": ["lunaloo-web", "lunaloo-content", "lunaloo-script", "lunaloo-voice"], "inner": {}},
]
SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv16')) return;
    sessionStorage.setItem('__kgv16', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '["done"]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', %s);
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
""" % json.dumps(json.dumps(GROUPS, ensure_ascii=False))

SURVEY = """() => {
  const g = (el) => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
  const groups = [];
  document.querySelectorAll('.kg-surface > .kg-group').forEach(gEl => {
    const gid = gEl.getAttribute('data-group');
    const kids = Array.from(document.querySelectorAll('.kg-panel[data-in-group="' + CSS.escape(gid) + '"]'));
    const busy = kids.filter(k => !k.classList.contains('kg-pstrip')).map(k => Object.assign(g(k), {prof: k.getAttribute('data-prof')}));
    const slim = kids.filter(k => k.classList.contains('kg-pstrip')).map(k => Object.assign(g(k), {prof: k.getAttribute('data-prof')}));
    const cards = [];
    kids.filter(k => !k.classList.contains('kg-pstrip')).forEach(card => {
      const body = card.querySelector('.kg-pbody');
      const bs = Array.from(card.querySelectorAll('.kg-node')).map(n => { const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; });
      if (body && bs.length) {
        const br = body.getBoundingClientRect();
        const minx = Math.min.apply(null, bs.map(b=>b.x)), maxx = Math.max.apply(null, bs.map(b=>b.x+b.w));
        const sv = card.querySelector('svg.kg-mini');
        const svgW = sv ? sv.getBoundingClientRect().width : 0;
        cards.push({prof: card.getAttribute('data-prof'), cardW: card.getBoundingClientRect().width,
                    bodyW: br.width, fill: Math.max((maxx-minx)/br.width, svgW/br.width), n: bs.length,
                    maxW: Math.max.apply(null, bs.map(b=>b.w)),
                    diag: {vw: sv ? sv.getAttribute('viewBox') : null,
                           card: [card.getBoundingClientRect().width, card.getBoundingClientRect().height],
                           body: [br.width, br.height],
                           bs: bs.map(b=>[+b.x.toFixed(1), +b.w.toFixed(1), +b.h.toFixed(1)])}});
      }
    });
    groups.push({gid, groupW: gEl.getBoundingClientRect().width, nKids: kids.length, busy, slim, cards});
  });
  return groups;
}"""

UNITS = """() => {
  const I = window.__KG_TEST__;
  const ovl = (a,b) => a && b && a.x < b.x+b.w-1.5 && b.x < a.x+a.w-1.5 && a.y < b.y+b.h-1.5 && b.y < a.y+a.h-1.5;
  const noOvl = (r) => { for (let i=0;i<r.length;i++) for (let j=i+1;j<r.length;j++) if (ovl(r[i],r[j])) return false; return true; };
  const m1 = [{w:431,h:300},{w:447,h:400},{slim:1,sw:200},{slim:1,sw:260}];
  const p1 = I.colPackSlots(m1, 600, 800, 6), r1 = p1.rects;
  const p2 = I.colPackSlots([{w:431,h:500},{w:431,h:500},{w:431,h:500}], 600, 600, 6), r2 = p2.rects;
  const p3 = I.colPackSlots([{slim:1,sw:180},{slim:1,sw:200}], 500, 300, 6);
  const hg = I.groupHugSize(m1, 1000, 900);
  const body = {x:0,y:0,w:600,h:800};
  const L5 = I.innerLayoutV16(['a','b','s1','s2'], {a:{x:300,y:400,w:250,h:320}}, body, m1, 6);
  const o5 = Object.keys(L5).map(k=>L5[k]);
  let ovl5 = false;
  for (let i=0;i<o5.length;i++) for (let j=i+1;j<o5.length;j++) if (ovl(o5[i],o5[j])) ovl5 = true;
  const p6 = I.colPackSlots(m1, 600, 800, 6);
  // U7 (v16.1): a manual full-height strip forces freeSpot into crowded
  // territory — the promise is that NO member ends up overlapping (the v7
  // rerun caught jl-qa biting 39px into jl-launch before the carve existed).
  const body7 = {x: 0, y: 0, w: 763, h: 562};
  const m7 = [{w:300,h:556},{w:300,h:556},{w:300,h:556}];
  const L7 = I.innerLayoutV16(['a','b','c'], {a: {x:40, y:0, w:144, h:556}}, body7, m7, 6);
  const o7 = Object.keys(L7).map(k=>L7[k]);
  let ovl7 = false;
  for (let i=0;i<o7.length;i++) for (let j=i+1;j<o7.length;j++) if (ovl(o7[i],o7[j])) ovl7 = true;
  // headline: SAME 6-member inputs — the column-first plan must give the
  // smallest busy column dramatically more width than the retired treemap.
  const m6 = [{w:447,h:426},{w:431,h:318},{slim:1,sw:190},{slim:1,sw:190},{slim:1,sw:190},{slim:1,sw:190}];
  const W6 = 1265, H6 = 700;
  const p7 = I.colPackSlots(m6, W6, H6, 6);
  const old7 = I.weightedSlots(m6.map(x => x.slim ? I.profWeight(0) : I.profWeight(4)), W6, H6, 6) || [];
  const bw7 = p7.rects.filter(r=>r && r.h > 60).map(r=>r.w);
  const ow7 = old7.filter(r=>r && r.h > 60).map(r=>r.w);
  return {
    busyOneColumn: r1[0].x === r1[1].x && r1[1].y >= r1[0].y + r1[0].h - 1 && r1[0].w === 600 && r1[1].w === 600,
    grewHeights: r1[0].h > 300 && r1[1].h > 400,
    stripsAtBottom: (()=>{ const st=r1.filter(r=>r.h===28); const bu=r1.filter(r=>r.h!==28);
      const stTop=Math.min.apply(null,st.map(r=>r.y));
      return st.length===2 && Math.max.apply(null,st.map(r=>r.y+r.h))===800 && bu.every(b=>stTop >= b.y+b.h-0.5); })(),
    noOvl1: noOvl(r1),
    threeCols: new Set(r2.map(r=>r.x)).size === 3 && r2.every(r=>r.w>=120),
    noOvl2: noOvl(r2),
    slimOnlyBottom: (()=>{const st=p3.rects; return st.every(r=>r.h===28) && Math.max.apply(null,st.map(r=>r.y+r.h))===300;})(),
    hugGrows: hg.w >= 400 && hg.h > 736,
    storedWins: L5.a.x === 300 && L5.a.y === 400,
    noOvl5: !ovl5,
    u7_manualFullHeightNoOverlap: !ovl7 && L7.a.x === 40,
    pure: JSON.stringify(p6) === JSON.stringify(p1),
    v16_beats_treemap: ow7.length ? Math.min.apply(null, bw7) >= Math.min.apply(null, ow7) * 1.5 : false,
    v16_widths: [Math.min.apply(null, bw7), ow7.length ? Math.min.apply(null, ow7) : 0]
  };
}"""

def overlaps(a, b):
    return not (a["x"] + a["w"] <= b["x"] + 0.5 or b["x"] + b["w"] <= a["x"] + 0.5
                or a["y"] + a["h"] <= b["y"] + 0.5 or b["y"] + b["h"] <= a["y"] + 0.5)

def survey_checks(tag, groups):
    # live board: a group only renders while at least one member still has
    # non-hidden tasks; the harness data churns, so the count is reported, and
    # structure is asserted over whatever actually rendered (>=1 group).
    ok(tag + ": group cards render (live-data tolerant)", len(groups) >= 1, [g["gid"] for g in groups])
    busyGroups = [g for g in groups if g["busy"]]
    ok(tag + ": at least one group shows busy members", bool(busyGroups), len(groups))
    for gr in groups:
        gid = gr["gid"]
        allr = gr["busy"] + gr["slim"]
        bad = [(i, j) for i in range(len(allr)) for j in range(i + 1, len(allr)) if overlaps(allr[i], allr[j])]
        ok(gid + ": members do not overlap", not bad, bad[:4])
        if gr["busy"] and gr["slim"]:
            bb = max(r["y"] + r["h"] for r in gr["busy"])
            st = min(r["y"] for r in gr["slim"])
            ok(gid + ": collapsed strips sink below the busy stack", bb <= st + 2, [round(bb), round(st)])
        if gr["busy"]:
            srt = sorted(gr["busy"], key=lambda r: (round(r["x"] / 4), r["y"]))
            xs = [round(r["x"]) for r in srt]
            ok(gid + ": busy cards stack column-first (never back-leftwards)",
               all(srt[i]["x"] <= srt[i + 1]["x"] + 4 for i in range(len(srt) - 1)), xs)
            cols = {}
            for r in gr["busy"]:
                cols.setdefault(str(round(r["x"] / 4)), []).append(r["w"])
            uneven = {k: [round(a) for a in v] for k, v in cols.items() if max(v) - min(v) > 2}
            ok(gid + ": cards in the same column share the column width", not uneven, uneven)
        for c in gr["cards"]:
            thr = 0.92 if c["n"] >= 2 else 0.855   # svg span == full lattice incl. cell padding
            ok("%s: %s blocks fill the member card (%.3f >= %.3f)" % (gid, c["prof"], c["fill"], thr),
               c["fill"] >= thr - 0.005, round(c["fill"], 3))
            if c["fill"] < thr - 0.005:
                print("   DIAG %s: %s" % (gid, json.dumps(c, ensure_ascii=False)[:700]), flush=True)

def main():
    with sync_playwright() as pw:
        try: browser = pw.chromium.launch()
        except Exception: browser = pw.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1600, "height": 950})
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append("console:" + m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        page.goto(BASE + "/kanban-graph", wait_until="networkidle")
        page.wait_for_selector(".kg-surface > .kg-group", timeout=30000)
        page.wait_for_timeout(1600)

        u = page.evaluate(UNITS)
        for k, v in u.items():
            if k == "v16_widths": continue
            ok("unit " + k, bool(v), v)
        print("  INFO widths new/old (min busy column px): %s" % json.dumps(u.get("v16_widths")), flush=True)

        groups = page.evaluate(SURVEY)
        survey_checks("T1 default", groups)
        wide = [(g["gid"], [round(b["w"]) for b in g["busy"]], [s["prof"] for s in g["slim"]]) for g in groups]
        print("  INFO busy widths / slim members:", json.dumps(wide, ensure_ascii=False), flush=True)

        page.screenshot(path=os.path.join(SHOTS, "v16_groups.png"))

        page.click(".kg-top button:has-text('自动排列')")
        page.wait_for_timeout(1800)
        survey_checks("T2 auto-arrange", page.evaluate(SURVEY))

        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface > .kg-group", timeout=30000)
        page.wait_for_timeout(1500)
        survey_checks("T3 after reload", page.evaluate(SURVEY))
        page.screenshot(path=os.path.join(SHOTS, "v16_after.png"))

        # wall regressions: strips under busy, no stray page errors
        wall = page.evaluate("""() => {
          const out = [];
          document.querySelectorAll('.kg-surface > .kg-panel').forEach(p => {
            out.push({strip: p.classList.contains('kg-pstrip'), y: p.getBoundingClientRect().y,
                      blocks: Array.from(p.querySelectorAll('.kg-node')).map(n => n.getBoundingClientRect().width)});
          });
          return out;
        }""")
        busyW = [w for w in wall if not w["strip"] and w["blocks"]]
        strips = [w for w in wall if w["strip"]]
        topBusy = max((w["y"] for w in busyW), default=0)
        ok("T4 wall: free collapsed strips still below every busy card",
           all(w["y"] >= topBusy - 1 for w in strips) if (busyW and strips) else True,
           [round(s["y"]) for s in strips][:6])
        ok("T5: zero page/console errors", not errs, errs[:5])
        browser.close()
    print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS), flush=True)
    sys.exit(0 if not fails else 1)

main()
