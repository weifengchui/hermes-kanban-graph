#!/usr/bin/env python
"""Compat/resilience probe for kanban-graph after the multi-profile wall landed.

Simulates a *pre-existing* user (only v4/v5 localStorage keys, no `mode` key)
then a hard refresh, and checks:
  A. default lands on the multi wall (7 panels, no overlap, no page errors)
  B. the old status filter / selected board keys are left alone
  C. 单板 mode still honours the legacy per-board position overrides (LS_POS)
  D. hiding a profile survives a hard reload (seed guarded one-shot!)
  E. board scope narrows the wall and persists

NOTE: ctx.add_init_script re-runs on every navigation, so the seed MUST be
guarded by a sessionStorage one-shot flag — otherwise the test wipes the very
state it is about to assert on (skill pitfall, hit once already).

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python _kg_compat_probe.py
"""
import json
import os
import sys
import urllib.request

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright

fails, notes = [], []

TERMINAL = {"done", "cancelled", "archived"}


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


def _api(path, token):
    req = urllib.request.Request(BASE + "/api/plugins/kanban-graph" + path,
                                 headers={"X-Hermes-Session-Token": token})
    return json.load(urllib.request.urlopen(req, timeout=25))


def board_view(token):
    """{slug: {'assignees': {...}, 'nodes': [...], 'linked': {...}}} from the API.

    The probe asserts against the live board data instead of snapshot counts:
    the earlier hardcoded expectations (7 panels / edu's 5 profiles / "the
    canvas draws some node") went red on 2026-10-11 purely because the board
    moved under them — every edu task had been finished, so 0 shipped nodes was
    the correct answer. Deriving the expectation keeps the assertion honest for
    every data state, including an all-settled board.
    """
    out = {}
    for b in _api("/boards", token).get("boards", []):
        g = _api("/graph?board=%s" % b["slug"], token)
        linked = set()
        for e in g.get("edges", []) + g.get("back_edges", []):
            linked.add(e["parent"])
            linked.add(e["child"])
        out[b["slug"]] = {"assignees": {n.get("assignee") for n in g["nodes"] if n.get("assignee")},
                          "nodes": g["nodes"], "linked": linked}
    return out


def single_nodes(info, hidden):
    """How many boxes 单板 must draw for one board: dependency-linked tasks plus
    unsettled unlinked ones, minus the statuses the legend hides. Mirrors
    buildModel (TERMINAL history never occupies the canvas)."""
    n = 0
    for t in info["nodes"]:
        if t["status"] in hidden:
            continue
        if t["id"] in info["linked"] or t["status"] not in TERMINAL:
            n += 1
    return n


# A seasoned user: board picked, one manual node position, a status hidden,
# "无依赖" toggled on — and crucially NO mode/hiddenProfiles/layout keys.
OLD = """
(function () {
  try {
    if (sessionStorage.getItem('__kgcompat')) return;
    sessionStorage.setItem('__kgcompat', '1');
    localStorage.setItem('hermes.kanbangraph.selectedBoard', 'edu');
    localStorage.setItem('hermes.kanbangraph.showUl', '1');
    localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify(['done']));
    localStorage.setItem('hermes.kanbangraph.pos.edu', JSON.stringify({'NODE-OVERRIDE-PLACEHOLDER': {x: 424, y: 96}}));
    localStorage.removeItem('hermes.kanbangraph.mode');
    localStorage.removeItem('hermes.kanbangraph.scope');
    localStorage.removeItem('hermes.kanbangraph.hiddenProfiles');
    localStorage.removeItem('hermes.kanbangraph.layout.__all__');
  } catch (e) {}
})();
"""

NO_OVERLAP = """() => {
  const r = Array.from(document.querySelectorAll('.kg-panel')).map(p => p.getBoundingClientRect());
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i], b = r[j];
    if (!(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1)) return false;
  }
  return true; }"""

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    errors = []
    ctx.add_init_script(OLD)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_timeout(3500)

    token = page.evaluate("window.__HERMES_SESSION_TOKEN__") or ""
    views = board_view(token)
    allprof = set()
    for v in views.values():
        allprof |= v["assignees"]
    profs = page.eval_on_selector_all(".kg-panel", "e => e.map(x => x.getAttribute('data-prof')).filter(x => x)")
    ok("no stored mode => wall shows every assigned profile of every board",
       set(profs) == allprof, "got=%s want=%s" % (sorted(set(profs)), sorted(allprof)))
    ok("no panels overlap", page.evaluate(NO_OVERLAP))
    ok("legacy selectedBoard key untouched", page.evaluate("localStorage.getItem('hermes.kanbangraph.selectedBoard')") == "edu")
    page.screenshot(path=SHOTS + "/08_compat_multi.png")

    # legacy per-board overrides still drive single mode
    page.get_by_text("单板", exact=True).first.click()
    page.wait_for_timeout(2500)
    ok("single mode renders the canvas", page.eval_on_selector_all(".kg-canvas", "e => e.length") == 1, "")
    nodes = page.eval_on_selector_all(".kg-svg .kg-node", "e => e.length")
    want = single_nodes(views["edu"], {"done"})
    ok("single mode draws exactly the drawable nodes of the seeded board",
       nodes == want, "got=%s want=%s (linked + unsettled, settled history dropped by design)" % (nodes, want))
    loaded = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.pos.edu')||'{}')")
    ok("legacy pos key untouched by the wall", "NODE-OVERRIDE-PLACEHOLDER" in loaded, list(loaded.keys()))
    page.screenshot(path=SHOTS + "/09_compat_single.png")

    # hide round-trip across a hard reload
    page.get_by_text("多 Profile", exact=True).first.click()
    page.wait_for_timeout(800)
    victim = (page.eval_on_selector_all(".kg-panel", "e => e.map(x => x.getAttribute('data-prof')).filter(x => x)") or ["?"])[-1]
    page.click('.kg-panel[data-prof="%s"] .kg-pclose' % victim)
    page.wait_for_timeout(400)
    ok("panel closes", page.eval_on_selector_all(".kg-panel[data-prof='%s']" % victim, "e => e.length") == 0, victim)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(2000)
    ok("hide survives a hard reload", page.eval_on_selector_all(".kg-panel[data-prof='%s']" % victim, "e => e.length") == 0, victim)
    ok("the rest of the wall came back",
       page.eval_on_selector_all('.kg-panel[data-prof]:not([data-prof=""])', "e => e.length") == len(allprof) - 1,
       "got=%s want=%s (profiles %d minus the closed victim)" % (
           page.eval_on_selector_all('.kg-panel[data-prof]:not([data-prof=""])', "e => e.length"), len(allprof) - 1, len(allprof)))

    # board scope narrows the wall and sticks
    # v20.1 debt rebase (v21 round): native select — use select_option.
    page.select_option("select.kg-native-sel", label="全部板")
    page.wait_for_timeout(300)
    page.select_option("select.kg-native-sel", label="教材站")
    page.wait_for_timeout(2500)
    scoped = set(page.eval_on_selector_all(".kg-panel", "e => e.map(x => x.getAttribute('data-prof')).filter(x => x)"))
    expect = views["edu"]["assignees"] - {victim}
    ok("scope narrows the wall to that board's profiles (minus the hidden one)",
       scoped == expect, "got=%s want=%s" % (sorted(scoped), sorted(expect)))
    ok("scope change is stored", page.evaluate("localStorage.getItem('hermes.kanbangraph.scope')") == "edu", "")
    page.screenshot(path=SHOTS + "/10_compat_scope.png")

    real = [e for e in errors if "Failed to load resource" not in e]
    ok("no page errors", not real, real[:5])
    browser.close()

print("\n".join(notes))
print()
if fails:
    print("FAILURES (%d):" % len(fails))
    print("\n".join(fails))
    sys.exit(1)
print("ALL PASS (%d assertions)" % len(notes))
