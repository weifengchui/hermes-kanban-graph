#!/usr/bin/env python3
"""kg_v18_hl.py — v18 acceptance: curve-only edges (switch removed), push-aside
vs join (overlap threshold), collapsed group member waking up re-runs the
group 自动排列, and the stability-gated wall pin surviving reloads.

Run: HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
     /home/yxf/.venvs/imgtools/bin/python kg_v18_hl.py
"""
import atexit, json, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:9119"
fails, notes = [], []
def ok(name, cond, got=None):
    line = ("PASS " if cond else "FAIL ") + name + ("" if cond else " got=" + json.dumps(got, ensure_ascii=False)[:600])
    print(line, flush=True); (notes if cond else fails).append(line)
def eq(name, got, want): ok(name + " == " + str(want), got == want, got)
atexit.register(lambda: (print("\n".join(fails), flush=True) if fails else None))

def ls(pg, k):
    return pg.evaluate("(k) => localStorage.getItem(k)", "hermes.kanbangraph." + k)

def setls(pg, k, v):
    pg.evaluate("(a) => localStorage.setItem(a[0], a[1])", ["hermes.kanbangraph." + k, v])

def wait_quiet(pg, ms=250, tries=10):
    # v18b: the wall can relayout shortly after load (wake/pin settle,
    # push-aside) — only sample rects once two consecutive frames match
    prev = None
    for _ in range(tries):
        cur = pg.evaluate("""() => [...document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')]
          .map(e => { const r = e.getBoundingClientRect(); return (e.dataset.prof||'')+'|'+Math.round(r.x)+'-'+Math.round(r.y)+'-'+Math.round(r.width)+'-'+Math.round(r.height); }).join(',')""")
        if prev == cur:
            return True
        prev = cur
        pg.wait_for_timeout(ms)
    return False


def card_rects(pg):
    return pg.evaluate("""() => {
      const out = {};
      document.querySelectorAll('.kg-surface > .kg-panel').forEach(el => {
        const r = el.getBoundingClientRect();
        out[el.dataset.prof] = { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      return out;
    }""")

def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1920, "height": 1080})
        pg.goto(BASE + "/kanban-graph", wait_until="networkidle")
        pg.evaluate("""() => {
          var K = 'hermes.kanbangraph.';
          localStorage.setItem(K + 'mode', 'multi');
          localStorage.setItem(K + 'scope', '');
          localStorage.setItem(K + 'hideSt', '["done"]');
          localStorage.setItem(K + 'grid', '0');
          localStorage.setItem(K + 'groups.__all__', '[]');
          localStorage.setItem(K + 'layout.__all__', '{}');
          localStorage.setItem(K + 'stripW.__all__', '{}');
          localStorage.setItem(K + 'maxed.__all__', '');
          localStorage.setItem(K + 'lineMode', 'straight');  // v18: a stale value must be IGNORED
          var rm = [];
          for (var i = 0; i < localStorage.length; i++) {
            var lk = localStorage.key(i);
            if (lk && lk.indexOf(K + 'miniPos.') === 0) rm.push(lk);
          }
          rm.forEach(function (lk) { localStorage.removeItem(lk); });
        }""")
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(3000)

        # ── T1: the switch is gone, curve rules even with a stale LS value ──
        eq("no 连线 button", pg.locator("button:has-text('连线')").count(), 0)
        eq("readLineMode removed", pg.evaluate("() => window.__KG_TEST__.readLineMode === undefined"), True)
        eq("stale LS straight ignored — every edge is a curve-mode path",
           pg.evaluate("""() => {
             const ds = [...document.querySelectorAll('.kg-mini path.kg-edge')];
             return ds.length >= 1 && ds.every(p => {
               const d = p.getAttribute('d');
               return d.startsWith('M') && p.classList.contains('kg-curve') &&
                      ((d.indexOf(' C ') > 0 && d.indexOf('L') < 0) ||
                       (d.split('L').length === 2 && d.indexOf('C') < 0));
             });
           }"""), True)

        # ── T5: pin settles and survives a reload ──
        wait_quiet(pg)
        lay = json.loads(ls(pg, "layout.__all__") or "{}")
        rects0 = card_rects(pg)
        ok("wall pinned after settle (layout non-empty)", len(lay) >= len(rects0) - 1, (list(lay), list(rects0)))
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2600)
        wait_quiet(pg)
        rects1 = card_rects(pg)
        same = all(abs(rects0[k][a] - rects1[k][a]) <= 2 for k in rects0 for k2 in [0] for a in ("x", "y") if k in rects1)
        ok("reload keeps every card exactly (pin stable, no mid-anim freeze)", same,
           [ (k, rects0[k], rects1.get(k)) for k in list(rects0)[:3] if k in rects1 and (abs(rects0[k]["x"]-rects1[k]["x"])>2 or abs(rects0[k]["y"]-rects1[k]["y"])>2) ])

        # ── T2: light overlap between two profile cards => the neighbour STEPS ASIDE ──
        # settle on two visible busy cards
        pair = pg.evaluate("""() => {
          const cs = [...document.querySelectorAll('.kg-surface > .kg-panel')]
            .filter(el => !el.classList.contains('kg-pstrip'))
            .map(el => { const r = el.getBoundingClientRect(); const hEl = el.querySelector('.kg-phead');
              const hr = hEl ? hEl.getBoundingClientRect() : null;
              return { id: el.dataset.prof, x: r.x, y: r.y, w: r.width, h: r.height,
                       hx: hr ? hr.x + Math.min(60, hr.width / 2) : 0, hy: hr ? hr.y + hr.height / 2 : 0 }; })
            .filter(c => c.hy > 40 && c.hy < 1030 && c.hx > 20 && c.hx < 1880 && c.w >= 80)
            .filter(c => { const el = document.elementFromPoint(Math.round(c.hx), Math.round(c.hy));
              const p = el && el.closest ? el.closest('.kg-panel') : null;
              return p && p.dataset.prof === c.id && !p.classList.contains('kg-pinner'); })
            .sort((a, b2) => a.w * a.h - b2.w * b2.h);
          return cs.length >= 2 ? [cs[0], cs[1]] : null;
        }""")
        ok("two normal cards available for overlap tests", bool(pair), pair)
        if pair:
            A, B = pair
            g_before = ls(pg, "groups.__all__")
            # light overlap: A's centre bites 0.3*min(w) into B => share <= 0.3
            # (the mouse carries the grab offset: the HEAD is grabbed, so the
            #  centre lands offset by (head - centre) from the pointer)
            # light overlap: the share metric is overlapArea/min(cardArea);
            # with full vertical overlap share = ox/w — aim the CENTRE so A
            # bites only ~0.3 of the width (share ≈ 0.3 < 0.5 => no join)
            gx0, gy0 = A["hx"], A["hy"]
            gdx, gdy = gx0 - (A["x"] + A["w"] / 2), gy0 - (A["y"] + A["h"] / 2)
            tx = B["x"] + 0.30 * min(A["w"], B["w"]) - A["w"] / 2 + gdx
            ty = min(B["y"] + B["h"] / 2, 1010) + gdy
            pg.mouse.move(gx0, gy0)
            pg.mouse.down()
            for f in (0.3, 0.6, 1.0):
                pg.mouse.move(gx0 + (tx - gx0) * f, gy0 + (ty - gy0) * f)
                pg.wait_for_timeout(70)
            pg.mouse.up()
            pg.wait_for_timeout(1000)
            r2 = card_rects(pg)
            eq("light overlap did NOT group them", ls(pg, "groups.__all__"), g_before)
            ov = None
            if B["id"] in r2 and A["id"] in r2:
                ox = min(r2[A["id"]]["x"] + r2[A["id"]]["w"], r2[B["id"]]["x"] + r2[B["id"]]["w"]) - max(r2[A["id"]]["x"], r2[B["id"]]["x"])
                oy = min(r2[A["id"]]["y"] + r2[A["id"]]["h"], r2[B["id"]]["y"] + r2[B["id"]]["h"]) - max(r2[A["id"]]["y"], r2[B["id"]]["y"])
                ov = (ox, oy)
            ok("the cards no longer overlap (push-aside made room)",
               ov is not None and (ov[0] <= 2 or ov[1] <= 2), (A["id"], B["id"], ov, r2.get(A["id"]), r2.get(B["id"])))

        # ── T3: a COVERING drop still joins (the group entry survives) ──
        pair2 = pg.evaluate("""() => {
          const cs = [...document.querySelectorAll('.kg-surface > .kg-panel')]
            .filter(el => !el.classList.contains('kg-pstrip'))
            .map(el => { const r = el.getBoundingClientRect(); const hEl = el.querySelector('.kg-phead');
              const hr = hEl ? hEl.getBoundingClientRect() : null;
              return { id: el.dataset.prof, x: r.x, y: r.y, w: r.width, h: r.height,
                       cx: r.x + r.width / 2, cy: r.y + r.height / 2,
                       hx: hr ? hr.x + Math.min(60, hr.width / 2) : 0, hy: hr ? hr.y + hr.height / 2 : 0 }; })
            .filter(c => c.hy > 40 && c.hy < 1030 && c.hx > 20 && c.hx < 1880 && c.w >= 80 &&
                          c.cy > 60 && c.cy < 1000 && c.w < 1400 && c.h < 920)
            .filter(c => { const el = document.elementFromPoint(Math.round(c.hx), Math.round(c.hy));
              const p = el && el.closest ? el.closest('.kg-panel') : null;
              return p && p.dataset.prof === c.id && !p.classList.contains('kg-pinner'); })
            .sort((a, b2) => a.w * a.h - b2.w * b2.h);
          return cs.length >= 2 ? [cs[0], cs[1]] : null;
        }""")
        if pair2:
            A2, B2 = pair2
            g3 = ls(pg, "groups.__all__")
            gx1, gy1 = A2["hx"], A2["hy"]
            gdx2, gdy2 = gx1 - (A2["x"] + A2["w"] / 2), gy1 - (A2["y"] + A2["h"] / 2)
            tx2, ty2 = B2["x"] + B2["w"] / 2 + gdx2, min(B2["y"] + B2["h"] / 2, 1000) + gdy2
            pg.mouse.move(gx1, gy1)
            pg.mouse.down()
            for f in (0.4, 0.8, 1.0):
                pg.mouse.move(gx1 + (tx2 - gx1) * f, gy1 + (ty2 - gy1) * f)
                pg.wait_for_timeout(70)
            pg.mouse.up()
            pg.wait_for_timeout(1000)
            gj = json.loads(ls(pg, "groups.__all__") or "[]")
            eq("groups grew by exactly 1 (covering drop joins)", len(gj),
               len(json.loads(g3 or "[]")) + 1, )
            mem = gj[-1]["members"] if gj else []
            # the JOIN target is the deepest-overlapping card — with a crowded
            # wall it may be a third card rather than B2; what must hold is that
            # the dragged card joined a fresh 2-member group.
            ok("the dragged card joined a fresh 2-member group",
               bool(gj) and len(gj[-1].get("members", [])) == 2 and A2["id"] in mem,
               (mem, A2["id"], B2["id"],
                [round(A2[k]) for k in "xywh"], [round(B2[k]) for k in "xywh"]))

        # ── T4: a member card that COLLAPSES (its tasks go away) and later
        # WAKES (tasks return) re-runs the group 自动排列. v21 rebase: the busy
        # pair is SELF-INJECTED (two synthetic wakeA/wakeB tasks on the edu
        # board) — live-data drift had dropped the real wall below 2 busy
        # profiles (chain round got=[], A/B got=1). The forged set is FOLDED
        # (wakeB -> done, hidden by hideSt) and WOKEN (back to ready) by a
        # flag inside one persistent route handler: deterministic, touches no
        # real data. ──
        folding = {"v": False}
        pg.evaluate("""() => {
          var K = 'hermes.kanbangraph.';
          localStorage.setItem(K + 'hideSt', '["done"]');
          localStorage.setItem(K + 'mode', 'multi');
          localStorage.setItem(K + 'scope', '');
          localStorage.setItem(K + 'groups.__all__', '[]');
          localStorage.setItem(K + 'layout.__all__', '{}');
          localStorage.setItem(K + 'maxed.__all__', '');
          localStorage.setItem(K + 'hiddenProfiles', '[]');
        }""")
        def forge(route):
            resp = route.fetch()
            try:
                data = resp.json()
            except Exception:
                route.fulfill(response=resp)
                return
            if "board=edu" in route.request.url:
                nodes = data.get("nodes") or []
                if not any((n.get("assignee") or "") == "wakeA" for n in nodes):
                    nodes.append({"id": "v18wakeA", "title": "V18-A", "status": "ready",
                                  "assignee": "wakeA", "priority": 1})
                if not any((n.get("assignee") or "") == "wakeB" for n in nodes):
                    nodes.append({"id": "v18wakeB", "title": "V18-B", "status": "ready",
                                  "assignee": "wakeB", "priority": 1})
                for n in nodes:
                    if n.get("id") == "v18wakeB":
                        n["status"] = "done" if folding["v"] else "ready"
                data["nodes"] = nodes
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(data, ensure_ascii=False))
        pg.route("**/api/plugins/kanban-graph/graph**", forge)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_timeout(3200)

        def busy_list():
            return pg.evaluate("""() => [...document.querySelectorAll('.kg-surface > .kg-panel')]
                .filter(el => !el.classList.contains('kg-pstrip') && el.dataset.prof)
                .map(el => el.dataset.prof)""")

        busy = busy_list()
        pA, pB = "wakeA", "wakeB"
        ok("the forged busy pair renders (self-seeded, data-drift-proof)",
           pA in busy and pB in busy, busy[:4])
        if pA in busy and pB in busy:
            gid = "v18wake"
            grp = [{"id": gid, "name": "V18唤醒", "members": [pA, pB],
                    "inner": {pA: {"x": 8, "y": 52, "w": 280, "h": 220},
                              pB: {"x": 300, "y": 52, "w": 280, "h": 220}}}]
            pg.evaluate("""(a) => {
              var K = 'hermes.kanbangraph.';
              localStorage.setItem(K + 'groups.__all__', JSON.stringify(a[0]));
              var lay = {}; lay['@g:' + a[1]] = { x: 120, y: 120, w: 620, h: 320 };
              localStorage.setItem(K + 'layout.__all__', JSON.stringify(lay));
            }""", [grp, gid])
            pg.reload(wait_until="domcontentloaded")
            pg.wait_for_timeout(3200)
            gA = json.loads(ls(pg, "groups.__all__") or "[]")
            innerA = (gA[0].get("inner") or {}) if gA else {}
            ok("group starts with stored member rects", len(innerA) == 2, innerA)
            ok("both members render inside the group",
               pg.locator('.kg-group[data-group="%s"] .kg-panel.kg-pinner' % gid).count() >= 2)

            # fold: wakeB's tasks flip to 'done' in every forged poll (done is
            # hidden via hideSt) -> visibleBlocks 0 -> the member collapses to
            # a strip INSIDE the group while its panel still exists
            folding["v"] = True
            pg.wait_for_timeout(6800)  # the 5s poll delivers the shrunken set
            folded = pg.evaluate("""(a) => document.querySelectorAll(
                '.kg-group[data-group="' + a[0] + '"] .kg-panel[data-prof="' + a[1] + '"].kg-pstrip').length > 0
            """, [gid, pB])
            ok("pB collapsed to a strip inside the group", folded, pB)

            # wake: flip the forged status back — the next poll returns pB busy
            folding["v"] = False
            pg.wait_for_timeout(7800)
            gB = json.loads(ls(pg, "groups.__all__") or "[]")
            innerB = (gB[0].get("inner") or {}) if gB else {}
            eq("woken member re-ran the group 自动排列 (rects cleared)", innerB, {})
        pg.unroute("**/api/plugins/kanban-graph/graph**")
        pg.screenshot(path="/tmp/kg_v18_shot.png")
        b.close()

        total = len(notes) + len(fails)
        print("\n%s (%d assertions)" % ("FAILURES:\n" + "\n".join(fails) if fails else "ALL PASS", total))
        raise SystemExit(1 if fails else 0)

main()
