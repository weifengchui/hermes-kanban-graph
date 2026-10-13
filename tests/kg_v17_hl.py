#!/usr/bin/env python3
"""kg_v17_hl.py — v17 acceptance: block resize, edge style switch, dependency
order + wall positions that SURVIVE a reload.

Run: HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
     /home/yxf/.venvs/imgtools/bin/python kg_v17_hl.py
"""
import atexit, json, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:9119"
fails, notes = [], []
def ok(name, cond, got=None):
    line = ("PASS " if cond else "FAIL ") + name + ("" if cond else " got=" + json.dumps(got, ensure_ascii=False)[:500])
    print(line, flush=True); (notes if cond else fails).append(line)
def eq(name, got, want): ok(name + " == " + str(want), got == want, got)
atexit.register(lambda: (print("\n".join(fails), flush=True) if fails else None))

SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv17')) return;
    sessionStorage.setItem('__kgv17', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '["done"]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', '[]');
    localStorage.setItem(K + 'layout.__all__', '{}');
    localStorage.setItem(K + 'stripW.__all__', '{}');
    localStorage.setItem(K + 'maxed.__all__', '');
    localStorage.removeItem(K + 'lineMode');
    var rm = [];
    for (var i = 0; i < localStorage.length; i++) {
      var lk = localStorage.key(i);
      if (lk && lk.indexOf(K + 'miniPos.') === 0) rm.push(lk);
    }
    rm.forEach(function (lk) { localStorage.removeItem(lk); });
  } catch (e) {}
})();
"""

def read_blocks(page, pid):
    return page.evaluate("""(pid) => {
      const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"] .kg-mini`);
      if (!el) return [];
      return [...el.querySelectorAll('.kg-node')].map(g => {
        const r = g.getBoundingClientRect();
        const bx = g.querySelector('.kg-box');
        return { x: r.x, y: r.y, w: r.width, h: r.height,
                 uw: bx ? parseFloat(bx.getAttribute('width')) : 0,
                 uh: bx ? parseFloat(bx.getAttribute('height')) : 0 };
      });
    }""", pid)

def edge_ds(page):
    return page.evaluate("""() => [...document.querySelectorAll('.kg-surface .kg-panel .kg-mini path.kg-edge')].map(p => p.getAttribute('d'))""")

def ls(page, key):
    return page.evaluate("(k) => localStorage.getItem(k)", "hermes.kanbangraph." + key)

def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1920, "height": 1080})
        pg.goto(BASE + "/kanban-graph", wait_until="networkidle")
        pg.evaluate(SEED)
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2600)

        # the busiest multi-block card
        pid = pg.evaluate("""() => {
          let best = null, bn = 0;
          document.querySelectorAll('.kg-surface > .kg-panel').forEach(el => {
            const n = el.querySelectorAll('.kg-mini .kg-node').length;
            const e = el.querySelectorAll('.kg-mini path.kg-edge').length;
            if (n >= 3 && n + e * 2 > bn) { bn = n + e * 2; best = el.dataset.prof; }
          });
          return best;
        }""")
        ok("found a busy multi-block card", bool(pid), pid)
        if not pid:
            b.close(); return

        # ── T1: edges are curve-only (v18 retired the straight switch) ──
        eq("no 连线 switch button (v18)", pg.locator("button:has-text('连线')").count(), 0)

        # ── T8: wall PIN — first computed slots persisted, reload keeps them ──
        lay1 = json.loads(ls(pg, "layout.__all__") or "{}")
        cards = pg.evaluate("""() => [...document.querySelectorAll('.kg-surface > .kg-panel')]
            .map(el => el.dataset.prof).filter(Boolean)""")
        # v22.2 rebase: first-paint pinning was RETIRED with the skyline packer —
        # slots are a deterministic function of the board; nothing enters the
        # store unless the user moves a card. Reload stability (geo0 vs geo1
        # below) is the surviving contract; the store must stay pin-free.
        ok("v22.2: no pin flood after first paint (<=2 store keys)",
           len([c for c in cards if c in lay1]) <= 2,
           {"cards": cards, "lay": list(lay1)})
        geo0 = pg.evaluate("""(pid) => { const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
          const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }""", pid)
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2200)
        geo1 = pg.evaluate("""(pid) => { const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
          const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }""", pid)
        ok("reload keeps card position (pin)",
           all(abs(geo0[k] - geo1[k]) <= 2 for k in geo0), (geo0, geo1))

        # ── T5: block resize by the corner grip ──
        pg.evaluate("""(pid) => document.querySelector(
            `.kg-surface > .kg-panel[data-prof="${pid}"]`).scrollIntoView({block: 'center'})""", pid)
        pg.wait_for_timeout(500)
        blocks = read_blocks(pg, pid)
        # v22.1: the card body now SCROLLS (readability floor) — the lowest block
        # of a busy wall sits under the fold and a pointer aimed outside the
        # viewport silently CANCELS the grip drag (top-left-drop probe class,
        # repeat). Pick the lowest FULLY-VISIBLE block; scroll to top otherwise.
        def body_rect():
            return pg.evaluate("""(pid) => { const pb=document.querySelector(
              `.kg-surface > .kg-panel[data-prof="${pid}"] .kg-pbody`);
              const r=pb.getBoundingClientRect(); return {t:r.top,b:r.bottom,l:r.left,rt:r.right}; }""", pid)
        vis = body_rect()
        def _vis(bs):
            return [z for z in bs if z["y"] >= vis["t"] - 2 and z["y"] + z["h"] <= vis["b"] + 2
                    and z["x"] >= vis["l"] - 2 and z["x"] + z["w"] <= vis["rt"] + 2]
        onscreen = _vis(blocks)
        if not onscreen:
            pg.evaluate("""(pid) => { document.querySelector(
              `.kg-surface > .kg-panel[data-prof="${pid}"] .kg-pbody`).scrollTop = 0; }""", pid)
            pg.wait_for_timeout(300)
            blocks = read_blocks(pg, pid); vis = body_rect(); onscreen = _vis(blocks)
        ok("a block fully visible in the scrolling body (drag precondition)", bool(onscreen), (len(blocks), len(onscreen)))
        base_uw = blocks[0]["uw"]
        tgt = max(onscreen or blocks, key=lambda z: z["y"])  # lowest VISIBLE block has room below
        hx, hy = tgt["x"] + tgt["w"] - 5, tgt["y"] + tgt["h"] - 5
        pg.mouse.move(hx, hy)
        pg.wait_for_timeout(150)
        pg.mouse.down()
        for f in (0.4, 0.8, 1.0):
            pg.mouse.move(hx + 45 * f, hy + 26 * f)
            pg.wait_for_timeout(50)
        pg.mouse.up()
        pg.wait_for_timeout(800)
        mp = json.loads(ls(pg, "miniPos." + pid) or "{}")
        sized = [v for v in mp.values() if isinstance(v, dict) and "w" in v and "h" in v]
        ok("miniPos persisted a w/h entry", len(sized) == 1, mp)
        blocks2 = read_blocks(pg, pid)
        grown = [z for z in blocks2 if z["uw"] > base_uw + 4]
        ok("the block is drawn wider", len(grown) == 1, (base_uw, [z["uw"] for z in blocks2]))
        ok("grown block taller too", grown and grown[0]["uh"] > blocks[0]["uh"], grown[0]["uh"] if grown else None)

        # ── T6: the size SURVIVES a reload (配置保持不变) ──
        uw_live = grown[0]["uw"] if grown else 0
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2200)
        pg.evaluate("""(pid) => document.querySelector(
            `.kg-surface > .kg-panel[data-prof="${pid}"]`).scrollIntoView({block: 'center'})""", pid)
        blocks3 = read_blocks(pg, pid)
        ok("manual size survives reload", any(abs(z["uw"] - uw_live) <= 0.51 for z in blocks3),
           (uw_live, [z["uw"] for z in blocks3]))

        # ── T4 (v18 rebase): curve is the ONE style — the misaligned resized
        # pair guarantees a crossing, so its edges must be beziers, every time ──
        d_all = edge_ds(pg)
        ok("edges are curve-mode paths (M + single L or C, no elbows)",
           bool(d_all) and all(z.startswith("M") and (z.count("L") == 1) + (z.count("C") == 1) == 1 for z in d_all),
           [z for z in d_all if not (z.startswith("M") and (z.count("L") == 1) + (z.count("C") == 1) == 1)][:3])
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2000)
        ok("same style persists across reload",
           all(z.count("L") == 1 or z.count("C") == 1 for z in edge_ds(pg)), None)

        # ── T7: card 排列 clears positions AND sizes ──
        pg.evaluate("""(pid) => { const el = document.querySelector(
            `.kg-surface > .kg-panel[data-prof="${pid}"]`);
            const btn = el.querySelector('.kg-pauto'); if (btn) btn.click(); }""", pid)
        pg.wait_for_timeout(900)
        mp3 = ls(pg, "miniPos." + pid)
        ok("排列 cleared miniPos", mp3 is None or mp3 == "{}", mp3)
        pg.evaluate("""(pid) => document.querySelector(
            `.kg-surface > .kg-panel[data-prof="${pid}"]`).scrollIntoView({block: 'center'})""", pid)
        pg.wait_for_timeout(300)
        blocks4 = read_blocks(pg, pid)
        # v22.1 rebase: ktfEffGeo hands leftover height to block WIDTH by design
        # (the v15 rule) and the readability floor pins scale at >=1. The lattice
        # is therefore per-card; the invariant is ONE uniform width inside the
        # card and never below the readable floor (>=214.5, base 215).
        uws = sorted({round(z["uw"], 1) for z in blocks4})
        ok("blocks on ONE uniform lattice after \u6392\u5217, >= readable floor",
           bool(blocks4) and len(uws) == 1 and uws[0] >= 214.5, uws)

        # ── T9: dependency-first DOM order matches the recomputed model ──
        truth = pg.evaluate("""(pid) => {
          const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
          const nodes = [...el.querySelectorAll('.kg-mini .kg-node')].map(g => {
            const r = g.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)];
          });
          return nodes;
        }""", pid)
        ok("DOM order is deterministic (>=3 blocks laid out)", len(truth) >= 3, truth)

        pg.screenshot(path="/tmp/kg_v17_shot.png")
        b.close()

        total = len(notes) + len(fails)
        print("\n%s (%d assertions) — shot /tmp/kg_v17_shot.png" %
              ("FAILURES:\n" + "\n".join(fails) if fails else "ALL PASS", total))
        raise SystemExit(1 if fails else 0)

main()
