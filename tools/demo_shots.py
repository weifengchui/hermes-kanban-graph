#!/usr/bin/env python3
"""Render the plugin against SYNTHETIC data and write screenshots/*.png.

Nothing from a real board is read: the plugin's three API routes are stubbed in
the browser before the page loads, so the shots are safe to publish.

    pip install playwright && playwright install chromium
    python tools/demo_shots.py                 # dashboard must be on :9119
    KG_BASE=http://127.0.0.1:9119 python tools/demo_shots.py
"""
import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("KG_BASE", "http://127.0.0.1:9119")
OUT = pathlib.Path(__file__).resolve().parents[1] / "screenshots"

BOARDS = [
    {"slug": "release", "title": "Release 2.0"},
    {"slug": "infra", "title": "Infra"},
    {"slug": "docs", "title": "Handbook"},
]

CHIPS = {
    "alice": ("DS v4", "DeepSeek · deepseek-v4", "#4d6bfe"),
    "bob": ("百炼 q3.8f", "DashScope · qwen3.8-flash", "#ff6a00"),
    "carol": ("OR gpt-5", "OpenRouter · gpt-5-mini", "#10a37f"),
    "dave": ("LOCAL q4", "127.0.0.1 · llama-3.1-8b", "#10b981"),
}

# board -> (profile, [ (id, title, status, deps...) ])
DEMO = {
    "release": [
        ("alice", [
            ("T-101", "Freeze the public API surface", "done", []),
            ("T-102", "Write the migration guide", "done", ["T-101"]),
            ("T-103", "Cut release/2.0 branch", "running", ["T-101"]),
            ("T-104", "Run the upgrade smoke suite", "running", ["T-103"]),
            ("T-105", "Publish the changelog", "todo", ["T-102", "T-104"]),
            ("T-106", "Announce on the blog", "ready", ["T-105"]),
        ]),
        ("bob", [
            ("T-201", "Benchmark the new planner", "done", ["T-103"]),
            ("T-202", "Tune the default cache size", "review", ["T-201"]),
            ("T-203", "Backport the planner fix", "blocked", ["T-202"]),
            ("T-204", "Document the benchmark rig", "todo", ["T-201"]),
        ]),
        ("carol", [
            ("T-301", "Refresh the marketing screenshots", "scheduled", []),
        ]),
    ],
    "infra": [
        ("dave", [
            ("I-11", "Move CI to the new runners", "done", []),
            ("I-12", "Pin the base image digest", "done", ["I-11"]),
            ("I-13", "Nightly database restore drill", "running", ["I-12"]),
            ("I-14", "Alert on queue depth", "todo", ["I-13"]),
            ("I-15", "Retire the legacy builder", "blocked", ["I-11"]),
        ]),
        ("alice", [
            ("I-21", "Cut the shared build cache over", "ready", ["I-12"]),
            ("I-22", "Delete the old cache buckets", "todo", ["I-21"]),
        ]),
    ],
    "docs": [
        ("dave", [
            ("D-01", "Outline the handbook", "done", []),
            ("D-02", "Write the onboarding chapter", "running", ["D-01"]),
            ("D-03", "Add the runbook index", "triage", ["D-01"]),
        ]),
    ],
}

STAMP = "2026-10-11T09:00:00"


def graphs():
    out = {}
    for slug, profs in DEMO.items():
        nodes, edges, back = [], [], []
        for who, rows in profs:
            tag, full, color = CHIPS[who]
            for tid, title, status, deps in rows:
                nodes.append({
                    "id": tid, "title": title, "status": status, "assignee": who,
                    "priority": 3, "created_at": STAMP,
                    "started_at": STAMP if status in ("running", "review", "done") else None,
                    "completed_at": STAMP if status == "done" else None,
                    "tenant": "demo", "tag": tag, "tagFull": full, "tagColor": color,
                })
                for d in deps:
                    edges.append({"parent": d, "child": tid})
        out[slug] = {"board": slug, "nodes": nodes, "edges": edges, "back_edges": back}
    return out


GRAPHS = graphs()
FIRST = DEMO["release"][0][1][2]


def task_payload(board, tid):
    for slug, profs in DEMO.items():
        for who, rows in profs:
            for t in rows:
                if t[0] != tid:
                    continue
                tag, full, color = CHIPS[who]
                refs = [{"id": x[0], "title": x[1], "status": x[2], "assignee": who} for x in rows]
                kids = [{"id": x[0], "title": x[1], "status": x[2], "assignee": who}
                        for x in rows if tid in x[3]]
                return {
                    "board": slug,
                    "task": {
                        "id": tid, "title": t[1], "status": t[2], "assignee": who,
                        "priority": 3, "created_at": STAMP,
                        "started_at": STAMP if t[2] in ("running", "review", "done") else None,
                        "completed_at": STAMP if t[2] == "done" else None,
                        "workspace_path": "~/work/demo", "branch_name": "release/2.0",
                        "body": "Demo description for %s.\n\n"
                                "- what this task is for\n- the acceptance criteria\n- who signs it off" % tid,
                    },
                    "parents": [r for r in refs if r["id"] in t[3]],
                    "children": kids,
                    "comments": [{"author": "reviewer", "body": "Looks ready to me.", "at": STAMP}],
                    "events": [{"kind": "status_changed", "payload": '{"to":"%s"}' % t[2], "at": STAMP}],
                    "runs": [{"profile": who, "status": "success", "outcome": "done",
                              "summary": "Demo run summary.", "error": "",
                              "started_at": STAMP, "ended_at": STAMP}],
                    "tag": tag, "tagFull": full, "tagColor": color,
                }
    return {"board": board, "task": {"id": tid, "title": "(not found)"}}


SEED = """
(function () {
  var K = 'hermes.kanbangraph.';
  localStorage.setItem(K + 'mode', 'multi');
  localStorage.setItem(K + 'scope', '');
  localStorage.setItem(K + 'selectedBoard', 'release');
  localStorage.setItem(K + 'crossEdges', '1');
  localStorage.setItem(K + 'grid', '1');
  Object.keys(localStorage).forEach(function (k) {
    if (k.indexOf(K) === 0) localStorage.removeItem(k);
  });
  localStorage.setItem(K + 'mode', 'multi');
  localStorage.setItem(K + 'scope', '');
  localStorage.setItem(K + 'selectedBoard', 'release');
  localStorage.setItem(K + 'crossEdges', '1');
  localStorage.setItem(K + 'grid', '1');
})();
"""

CARDS = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-prof'), kind: el.classList.contains('kg-group') ? 'group' : 'prof',
           x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})"""


def handle(route):
    url = route.request.url
    if "/boards" in url:
        body = {"current": "release", "boards": BOARDS}
    elif "/task?" in url:
        q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&") if "=" in p)
        body = task_payload(q.get("board", "release"), q.get("id", ""))
    elif "/graph?" in url:
        q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&") if "=" in p)
        body = GRAPHS.get(q.get("board", ""), {"board": "", "nodes": [], "edges": [], "back_edges": []})
    else:
        route.continue_()
        return
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps(body, ensure_ascii=False))


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / name))
    print("wrote", OUT / name)


def head_xy(page, sel):
    b = page.query_selector(sel + " .kg-phead, " + sel + " .kg-ghead").bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


def drag(page, a, b, steps=14):
    page.mouse.move(a[0], a[1])
    page.mouse.down()
    for k in range(1, steps + 1):
        page.mouse.move(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps)
        page.wait_for_timeout(22)
    page.mouse.up()
    page.wait_for_timeout(360)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1600, "height": 950})
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        page.route("**/api/plugins/kanban-graph/**", handle)
        page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
        page.wait_for_selector(".kg-panel", timeout=20000)
        page.wait_for_timeout(3200)
        shot(page, "01-wall.png")

        # group two profiles, then let the content-aware layout size them
        profs = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(p => {
          const r = p.getBoundingClientRect();
          return { id: p.getAttribute('data-prof'), x: Math.round(r.x), y: Math.round(r.y),
                   w: Math.round(r.width), h: Math.round(r.height),
                   n: parseInt((p.querySelector('.kg-pcount') || {}).textContent || '0', 10) || 0 };
        })""")
        if len(profs) < 2:
            raise SystemExit("need at least two profile cards to demo grouping")
        src = min(profs, key=lambda c: (c["n"], c["id"]))
        dst = max(profs, key=lambda c: (c["n"], c["id"]))
        drag(page, head_xy(page, '.kg-surface > .kg-panel[data-prof="%s"]' % src["id"]),
             (dst["x"] + dst["w"] / 2, dst["y"] + dst["h"] / 2))
        page.wait_for_timeout(500)
        if not page.eval_on_selector_all(".kg-group", "e => e.length"):
            raise SystemExit("grouping did not happen — nothing to screenshot")
        page.hover(".kg-surface > .kg-group")
        page.click(".kg-surface > .kg-group .kg-gauto")
        page.wait_for_timeout(600)
        shot(page, "02-groups.png")

        # reference grid, caught mid-drag
        cards = page.evaluate(CARDS)
        t = [c for c in cards if c["kind"] != "group"] or cards
        sel = '.kg-surface > .kg-panel[data-prof="%s"]' % t[0]["id"]
        hx, hy = head_xy(page, sel)
        page.hover(sel)
        page.mouse.move(hx, hy)
        page.mouse.down()
        for k in range(1, 8):
            page.mouse.move(hx + k * 11, hy + k * 7)
            page.wait_for_timeout(28)
        shot(page, "03-drag-grid.png")
        page.mouse.up()
        page.wait_for_timeout(400)

        # task detail popup
        page.dblclick('.kg-surface > .kg-panel[data-prof="alice"] svg.kg-mini g.kg-node')
        page.wait_for_selector(".kg-modal", timeout=10000)
        page.wait_for_timeout(900)
        shot(page, "04-task-popup.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        # single-board DAG
        page.get_by_text("单板", exact=True).first.click()
        page.wait_for_timeout(3200)
        shot(page, "05-single-board.png")
        browser.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
