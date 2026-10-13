# Board+ wall VERTICAL waste survey (v22, 2026-10-13): per-card dead band below
# the block grid + how much of the wall is below the fold. Run:
#   HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
#   /home/yxf/.venvs/imgtools/bin/python tools/_kg_fillv_survey.py [outfile.png]
import json, sys
from playwright.sync_api import sync_playwright

SURVEY = """() => {
  const VH = window.innerHeight, VW = window.innerWidth;
  const out = [];
  let wall = 0;
  const surf = document.querySelector('.kg-surface');
  if (surf) wall = surf.scrollHeight || surf.getBoundingClientRect().height;
  document.querySelectorAll('.kg-panel').forEach(p => {
    const pr = p.getBoundingClientRect();
    if (pr.width < 4) return;
    const head = p.querySelector(':scope > .kg-phead');
    const hb = head ? head.getBoundingClientRect().bottom : pr.top;
    const blocks = [...p.querySelectorAll(':scope .kg-node')]
      .filter(n => n.closest('.kg-panel') === p);
    const name = ((head || {}).textContent || '').trim().slice(0, 22);
    if (!blocks.length) {
      out.push({ name, inGroup: !!p.closest('.kg-group-card, .kg2-group-card, [class*="group-card"]'),
                 pw: Math.round(pr.width), ph: Math.round(pr.height), n: 0,
                 vfill: null, dead: null, fold: (pr.top >= VH ? 'below' : (pr.bottom > VH ? 'cut' : 'in')) });
      return;
    }
    const rs = blocks.map(b => b.getBoundingClientRect());
    const top = Math.min(...rs.map(r => r.y)), bot = Math.max(...rs.map(r => r.bottom));
    const innerH = Math.max(1, pr.bottom - hb);
    out.push({ name, inGroup: !!p.closest('.kg-group-card, .kg2-group-card, [class*="group-card"]'),
               pw: Math.round(pr.width), ph: Math.round(pr.height), n: rs.length,
               vfill: +(((bot - hb) / innerH) * 100).toFixed(1),
               dead: Math.round(pr.bottom - bot),
               fold: (pr.top >= VH ? 'below' : (pr.bottom > VH ? 'cut' : 'in')) });
  });
  return { VH, VW, wall: Math.round(wall), cards: out };
}"""

outfile = sys.argv[1] if len(sys.argv) > 1 else "/tmp/kg_fillv.png"
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:9119/kanban-graph", wait_until="networkidle", timeout=90000)
    pg.wait_for_selector(".kg-panel", timeout=60000)
    pg.wait_for_timeout(1800)
    data = pg.evaluate(SURVEY)
    pg.screenshot(path=outfile)
    b.close()

print("viewport %dx%d  wall height %d  (fold at y=%d)" % (data["VW"], data["VH"], data["wall"], data["VH"]))
rows = [c for c in data["cards"] if c["n"] > 0]
rows.sort(key=lambda r: (r["vfill"] is None) and 999 or r["vfill"])
print("%-22s %-6s %5s %5s %4s %7s %6s %-5s" % ("card", "grp?", "pw", "ph", "n", "vfill%", "dead", "fold"))
for r in rows:
    print("%-22s %-6s %5d %5d %4d %7s %6d %-5s" % (r["name"], str(r["inGroup"]), r["pw"], r["ph"], r["n"], r["vfill"], r["dead"], r["fold"]))
below = [c for c in data["cards"] if c["fold"] != "in"]
print("blocks-bearing cards:", len(rows), "| not fully above fold:", len(below),
      "| dead-band total (busy cards):", sum(r["dead"] for r in rows))
print("vfill<80% cards:", sum(1 for r in rows if r["vfill"] < 80))
