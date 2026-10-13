#!/usr/bin/env python
"""Headless acceptance for kanban-graph v8.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v8_hl.py

Covers the three asks of this round:
  1 every task block shows the API provider + model it runs on (short chip +
    colour + full text in the tooltip), and the chip never overflows its box
  2 dragging the resize grip only grows the card — the left/top must not travel
    with the pointer (regression: the delta used to be applied twice)
  3 a group card's title can be renamed in place (double-click the title,
    type, Enter saves; the name survives a reload)
NOTE: the seed runs on every navigation, so it must be guarded one-shot.
"""
import json
import os
import re
import sys
import urllib.request

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright  # noqa: E402

fails, notes = [], []


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


HERMES = "/home/yxf/.hermes"
# Small, deliberate map: base_url needle -> (label the plugin prints, short code).
# This is the *contract* ("the chip shows the model that profile's config
# declares"), so it must be re-derived when a provider is added on purpose —
# never replaced by a snapshot of today's model names (that is what broke here
# on 2026-10-11: jrmath-lab was switched from qwen to deepseek and the old
# hardcoded expectation ["百炼 q3.8f"] failed while the UI was right).
PROV = (("deepseek", "DeepSeek", "DS"), ("aliyuncs", "百炼", "百炼"),
        ("dashscope", "百炼", "百炼"), ("openrouter", "OpenRouter", "OR"),
        ("anthropic", "Anthropic", "AN"), ("api.openai.com", "OpenAI", "OA"))


def cfg_of(prof):
    """(label, short, model) exactly as profiles/<prof>/config.yaml declares it."""
    p = os.path.join(HERMES, "profiles", prof, "config.yaml")
    if not os.path.exists(p):
        return None
    base, model = "", ""
    in_model = False
    for line in open(p, encoding="utf-8", errors="replace"):
        if re.match(r"^model:\s*$", line):
            in_model = True
            continue
        if in_model and re.match(r"^\S", line):
            in_model = False
        if in_model:
            m = re.match(r"^\s+base_url:\s*(\S+)", line)
            if m:
                base = m.group(1)
            m = re.match(r"^\s+(?:default|model_name):\s*(\S+)", line)
            if m:
                model = m.group(1).strip("'\"")
        if base and model:
            break
    for needle, label, short in PROV:
        if needle in base:
            return label, short, model
    return None


def api_tags(token):
    """{assignee: {(chip, tagFull)}} straight from the plugin's own /graph."""
    out = {}
    req = urllib.request.Request(BASE + "/api/plugins/kanban-graph/boards",
                                 headers={"X-Hermes-Session-Token": token})
    boards = json.load(urllib.request.urlopen(req, timeout=25)).get("boards", [])
    for b in boards:
        url = BASE + "/api/plugins/kanban-graph/graph?board=%s&include_archived=true" % b["slug"]
        req = urllib.request.Request(url, headers={"X-Hermes-Session-Token": token})
        try:
            g = json.load(urllib.request.urlopen(req, timeout=25))
        except Exception:
            continue
        for n in g.get("nodes", []):
            a = n.get("assignee")
            if a and n.get("tag"):
                out.setdefault(a, set()).add((n["tag"], n.get("tagFull") or ""))
    return out


SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv8')) return;
    sessionStorage.setItem('__kgv8', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'selectedBoard', 'edu');
    localStorage.setItem(K + 'crossEdges', '1');
    ['hiddenProfiles', 'layout.__all__', 'layout.edu', 'maxed.__all__', 'groups.__all__'].forEach(function (k) {
      localStorage.removeItem(K + k);
    });
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf(K + 'miniPos.') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
})();
"""

CARDS = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-prof'), kind: el.classList.contains('kg-group') ? 'group' : 'prof',
           x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})"""

GROUPS = """() => Array.from(document.querySelectorAll('.kg-group')).map(g => ({
  id: g.getAttribute('data-group'),
  name: (g.querySelector('.kg-gname') || g.querySelector('.kg-gname-edit') || {}).value ||
        (g.querySelector('.kg-gname') || {}).textContent || '',
  members: Array.from(g.querySelectorAll('.kg-panel')).map(p => p.getAttribute('data-prof'))
}))"""

# every task block in a panel, with the boxes of chip / meta / status text
CHIPS = """() => {
  const out = [];
  document.querySelectorAll('svg.kg-mini g.kg-node').forEach(g => {
    const box = g.querySelector('rect.kg-box');
    const panel = g.closest('.kg-panel');
    const bb = e => { const el = g.querySelector(e); if (!el) return null; const q = el.getBBox();
                      return [+q.x.toFixed(1), +q.y.toFixed(1), +(q.x + q.width).toFixed(1), +(q.y + q.height).toFixed(1)]; };
    const rep = { prof: panel ? panel.getAttribute('data-prof') : '',
                  tip: (g.querySelector('title') || {}).textContent || '',
                  box: [+box.getAttribute('width'), +box.getAttribute('height')], has: false,
                  asg: ((g.querySelector('text.kg-asg') || {}).textContent || g.id || '').trim(),
                  ttl: bb('text.kg-title'), meta: bb('text.kg-asg'), stat: bb('text.kg-st') };
    const t = g.querySelector('text.kg-mtag');
    if (t) {
      rep.has = true; rep.text = t.textContent; rep.fill = t.getAttribute('fill');
      rep.tag = bb('text.kg-mtag'); rep.pill = bb('rect.kg-mpill');
      rep.aTxt = (g.querySelector('text.kg-asg') || {}).textContent || '';
    }
    out.push(rep);
  });
  return out;
}"""


def hits(a, b):
    return bool(a and b) and not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def overlaps(list_):
    out = []
    for i in range(len(list_)):
        for j in range(i + 1, len(list_)):
            a, b = list_[i], list_[j]
            if not (a["x"] + a["w"] <= b["x"] + 1 or b["x"] + b["w"] <= a["x"] + 1 or
                    a["y"] + a["h"] <= b["y"] + 1 or b["y"] + b["h"] <= a["y"] + 1):
                out.append("%s/%s" % (a["id"], b["id"]))
    return out


def drag(page, from_xy, to_xy, steps=10):
    page.mouse.move(from_xy[0], from_xy[1])
    page.mouse.down()
    for k in range(1, steps + 1):
        page.mouse.move(from_xy[0] + (to_xy[0] - from_xy[0]) * k / steps,
                        from_xy[1] + (to_xy[1] - from_xy[1]) * k / steps)
        page.wait_for_timeout(25)
    page.mouse.up()
    page.wait_for_timeout(320)


def head_xy(page, sel):
    b = page.query_selector(sel + " .kg-phead, " + sel + " .kg-ghead").bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


def soff(page, sel):
    """Scroll-invariant card box (offsets inside .kg-surface). A v14 wall is taller than
    the fold, so getBoundingClientRect() y moves with board scroll and fakes a delta."""
    return page.evaluate("""(sel) => { const el = document.querySelector(sel);
      return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }; }""", sel)


def aim_grip(page, sel):
    """Scroll the resize grip into frame; return (grip box, viewport) measured in one frame.

    A v14 wall is taller than the fold and Playwright's scroll_into_view_if_needed can
    leave the grip a few px BELOW the viewport (seen at y=914 with a 900px viewport);
    mouse.down() there is a silent miss, which showed up as "resize grew by 0". So:
    centre the card, then walk the board scroller until the grip is comfortably inside."""
    page.evaluate("""(sel) => document.querySelector(sel).scrollIntoView({block:'center'})""", sel)
    page.wait_for_timeout(200)
    box = None
    for _ in range(24):
        q = page.query_selector(sel + " .kg-prsz")
        if not q:
            return None, page.evaluate("() => [innerWidth, innerHeight]")
        box = q.bounding_box()
        if box and 120 < box["y"] and box["y"] + box["height"] < 860:
            break
        # v20.1 rebase: walk by the GRIP's own offset (the old card-height
        # heuristic scrolled the WRONG way for tall cards: height/2-400 < 0
        # scrolled up while the grip sat 1000px below the fold).
        off = (box["y"] + box["height"] - 700) if box else 300
        if box and box["y"] <= 120:
            off = box["y"] - 200
        page.evaluate("(off) => { const s = document.querySelector('.kg-board'); if (s) s.scrollTop += off; }", off)
        page.wait_for_timeout(120)
    return box, page.evaluate("() => [innerWidth, innerHeight]")


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors, bad = [], []
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)
    page.on("response", lambda r: bad.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(3200)

    # ── 1. provider / model chip on every task block ──
    chips = page.evaluate(CHIPS)
    ok("task blocks were rendered", len(chips) >= 10, len(chips))
    # expectations are derived live: the profile's own config.yaml (what it
    # declares) and the plugin's /graph (what the backend computed). A snapshot
    # of model names goes stale the moment a profile is switched — it did on
    # 10-11 (jrmath-lab moved qwen -> deepseek) and the FAIL was the probe's.
    token = page.evaluate("window.__HERMES_SESSION_TOKEN__") or ""
    tags = api_tags(token)
    # 契约只约束「受理人有后端模型记录」的块；板名/外部受理人（如 'edu'）没有
    # 模型可显示，无芯片是合法形态（10-11 pi 建了 assignee=板名 的块）
    missing = [c["prof"] + "/" + c.get("asg", "?") for c in chips
               if not c["has"] and c.get("asg") and c["asg"] in tags]
    ok("every model-known task block carries a provider/model chip", not missing, missing[:6])
    ok("the API reports a provider/model tag for the assigned profiles",
       len(tags) >= 4, sorted(tags))
    seen = {}
    for c in chips:
        if c["has"]:
            seen.setdefault(c["prof"], set()).add(c.get("text"))
    texts = sorted(set(t for v in seen.values() for t in v))
    ok("chip text is a short code + model (two tokens, <= 12 chars)",
       all(re.match(r"^\S+ \S+$", t) and len(t) <= 12 for t in texts), texts)
    wrong_a = [(p, sorted(v), sorted({t for t, _ in tags.get(p, set())}))
               for p, v in seen.items() if tags.get(p) and v != {t for t, _ in tags[p]}]
    ok("every chip equals the tag the API reports for that profile", not wrong_a, wrong_a[:3])
    wrong_b = []
    for p in sorted(seen):
        c = cfg_of(p)
        if not c or not c[2]:
            continue  # profile or model missing -> backend draws no chip by design
        want = c[0] + " · " + c[2]
        have = {f for _, f in tags.get(p, set())}
        if have and want not in have:
            wrong_b.append((p, want, sorted(have)))
    ok("each profile shows the model its own config declares", not wrong_b, wrong_b[:3])
    fills = sorted(set(c.get("fill") for c in chips if c["has"]))
    ok("chip colour is a real provider colour (backend-supplied, not invented)",
       bool(fills) and all(re.match(r"^#[0-9a-f]{6}$", f) for f in fills), fills)
    tipbad = [c["prof"] for c in chips if c["has"]
              and not any(f and f in c["tip"] for _, f in tags.get(c["prof"], set()))]
    ok("tooltip carries the full provider · model for every profile", not tipbad, tipbad[:3])

    over = []
    for c in chips:
        if not c["has"]:
            continue
        W, H = c["box"]
        for name in ("tag", "pill", "meta", "stat", "ttl"):
            b = c.get(name)
            if not b:
                continue
            if b[2] > W - 1 or b[3] > H - 1 or b[0] < 0 or b[1] < 0:
                over.append((c["prof"], name, b, [W, H]))
    ok("nothing in a block crosses its border", not over, over[:4])

    coll = []
    for c in chips:
        if not c["has"]:
            continue
        if hits(c.get("pill"), c.get("ttl")):
            coll.append(("pill/title", c["prof"], c.get("pill"), c.get("ttl")))
        if hits(c.get("tag"), c.get("meta")):
            coll.append(("chip/meta", c["prof"], c.get("tag"), c.get("meta")))
        if hits(c.get("tag"), c.get("stat")):
            coll.append(("chip/status", c["prof"], c.get("tag"), c.get("stat")))
        if hits(c.get("meta"), c.get("stat")):
            coll.append(("meta/status", c["prof"], c.get("meta"), c.get("stat")))
    ok("chip / title / meta / status never overlap", not coll, coll[:5])
    truncated = [c["aTxt"] for c in chips if c.get("aTxt", "").endswith("…")]
    ok("a long board name is truncated instead of colliding", all(len(t) <= 14 for t in truncated), truncated[:4])
    page.screenshot(path=SHOTS + "/v8_01_chips.png", full_page=False)

    # the same chip is drawn on the single-board canvas
    page.get_by_text("单板", exact=True).first.click()
    page.wait_for_timeout(2600)
    main = page.evaluate("""() => Array.from(document.querySelectorAll('svg.kg-svg g.kg-node')).map(g => {
      const t = g.querySelector('text.kg-mtag'); const box = g.querySelector('rect.kg-box');
      if (!t) return null;
      const b = t.getBBox();
      return { text: t.textContent, right: +(b.x + b.width).toFixed(1), bottom: +(b.y + b.height).toFixed(1),
               W: +box.getAttribute('width'), H: +box.getAttribute('height') };
    }).filter(Boolean)""")
    ok("the single-board canvas also shows the chip", len(main) >= 1, len(main))
    ok("main-canvas chips stay inside their box",
       all(m["right"] <= m["W"] and m["bottom"] <= m["H"] for m in main), main[:3])
    page.screenshot(path=SHOTS + "/v8_01b_main_chips.png")
    page.get_by_text("多 Profile", exact=True).first.click()
    page.wait_for_timeout(2200)

    # ── 2. dragging the resize grip must not move the card ──
    start = page.evaluate(CARDS)
    ok("no cards overlap at first paint", not overlaps(start), overlaps(start))
    # v20.1 rebase: the LARGEST card is often a tall hug whose grip sits far
    # below the fold (wall got taller; aim_grip walk can't rescue 1000px).
    # Pick the SMALLEST roomy card — same gesture coverage, grip on screen.
    cands = [c for c in start if c["w"] >= 160 and c["h"] >= 140]
    tgt = min(cands or start, key=lambda c: c["w"] * c["h"])
    sel = '.kg-surface > .kg-panel[data-prof="%s"]' % tgt["id"]
    tgt.update(soff(page, sel))          # baseline in surface coords, not viewport
    grip, vp = aim_grip(page, sel)
    gx, gy = grip["x"] + grip["width"] - 4, grip["y"] + grip["height"] - 4
    ok("the resize grip is reachable inside the viewport", 0 < gx < vp[0] and 0 < gy < vp[1],
       "grip=%d,%d vp=%s" % (gx, gy, vp))
    page.hover(sel)
    drag(page, (gx, gy), (gx + 128, gy + 88), steps=12)
    resized = [c for c in page.evaluate(CARDS) if c["id"] == tgt["id"]]
    ok("the resized card survived the gesture", len(resized) == 1, resized)
    if resized:
        r = dict(resized[0]); r.update(soff(page, sel))
        ok("resize keeps the card's origin (x/y)", abs(r["x"] - tgt["x"]) <= 2 and abs(r["y"] - tgt["y"]) <= 2,
           "before=%s,%s after=%s,%s" % (tgt["x"], tgt["y"], r["x"], r["y"]))
        ok("resize grows by ~the pointer delta (not twice it)",
           abs((r["w"] - tgt["w"]) - 128) <= 16 and abs((r["h"] - tgt["h"]) - 88) <= 16,
           "dw=%s dh=%s (want ~128/88)" % (r["w"] - tgt["w"], r["h"] - tgt["h"]))
    after = page.evaluate(CARDS)
    ok("no cards overlap after the resize", not overlaps(after), overlaps(after))
    page.screenshot(path=SHOTS + "/v8_02_resized.png")
    # shrink it back to prove the gesture is symmetric
    grip2, _ = aim_grip(page, sel)
    hx, hy = grip2["x"] + grip2["width"] - 4, grip2["y"] + grip2["height"] - 4
    drag(page, (hx, hy), (hx - 128, hy - 88), steps=12)
    back = dict([c for c in page.evaluate(CARDS) if c["id"] == tgt["id"]][0])
    back.update(soff(page, sel))
    ok("resize shrinks symmetrically", abs(back["w"] - tgt["w"]) <= 16 and abs(back["h"] - tgt["h"]) <= 16,
       "w=%s h=%s vs %s/%s" % (back["w"], back["h"], tgt["w"], tgt["h"]))

    # ── 3. inline rename of a group card ──
    # Reset the scroller and pick cards by what is ACTUALLY visible (T2's grip-walk
    # leaves the board scrolled; DOM order then points at cards outside the frame).
    page.evaluate("""() => { const s = document.querySelector('.kg-board'); if (s) s.scrollTop = 0; }""")
    page.wait_for_timeout(300)
    vis = page.evaluate(CARDS)
    vp = page.evaluate("() => [innerWidth, innerHeight]")
    vis = [c for c in vis if c["x"] < vp[0] - 60 and c["y"] < vp[1] - 60
           and c["x"] + c["w"] > 60 and c["y"] + c["h"] > 60]
    vis.sort(key=lambda c: -(c["w"] * c["h"]))
    ok("at least two cards are visible for the group gesture", len(vis) >= 2,
       "%d visible of %d" % (len(vis), len(page.evaluate(CARDS))))
    a, b = vis[0], vis[1]
    sela = '.kg-surface > .kg-panel[data-prof="%s"]' % a["id"]
    selb = '.kg-surface > .kg-panel[data-prof="%s"]' % b["id"]
    # v14 stretched the wall to fill the board, so a card's *geometric* centre can sit
    # outside the viewport -- mouse.move() there does nothing and no group forms (this
    # crash was a dblclick waiting 30s for a .kg-group that never existed). Scroll both
    # sides into frame, re-measure, and drop on the VISIBLE intersection of the target.
    page.locator(sela + " .kg-phead").scroll_into_view_if_needed(timeout=5000)
    page.wait_for_timeout(200)
    b2 = [c for c in page.evaluate(CARDS) if c["id"] == b["id"]][0]
    ix0, iy0 = max(b2["x"], 0), max(b2["y"], 0)
    ix1, iy1 = min(b2["x"] + b2["w"], vp[0]), min(b2["y"] + b2["h"], vp[1])
    ok("the drop target has a visible region to aim at", ix1 - ix0 > 60 and iy1 - iy0 > 60,
       "%dx%d of card %dx%d" % (ix1 - ix0, iy1 - iy0, b2["w"], b2["h"]))
    drag(page, head_xy(page, sela), ((ix0 + ix1) / 2, (iy0 + iy1) / 2))
    page.wait_for_timeout(400)
    groups = page.evaluate(GROUPS)
    ok("dragging a card onto another forms a group", len(groups) == 1 and len(groups[0]["members"]) == 2, groups)
    if not groups:
        print("\n".join(notes)); print()
        print("FAILURES (%d):" % (len(fails) + 1))
        print("\n".join(fails + ["group did not form -> rename/maximise section cannot run"]))
        browser.close()
        sys.exit(1)
    page.screenshot(path=SHOTS + "/v8_03_group.png")
    page.dblclick(".kg-group .kg-gname")
    page.wait_for_timeout(320)
    ok("double-clicking the group title opens an inline editor",
       page.eval_on_selector_all(".kg-gname-edit", "e => e.length") == 1, "")
    ok("the editor is focused and holds the old name",
       page.eval_on_selector_all(".kg-gname-edit", "e => e.map(x => [document.activeElement === x, x.value])") == [[True, "分组 1"]],
       page.eval_on_selector_all(".kg-gname-edit", "e => e.map(x => [document.activeElement === x, x.value])"))
    page.fill(".kg-gname-edit", "数学冲刺")
    page.keyboard.press("Enter")
    page.wait_for_timeout(420)
    ok("Enter saves the new title", page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)") == ["数学冲刺"],
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)"))
    ok("no editor is left behind", page.eval_on_selector_all(".kg-gname-edit", "e => e.length") == 0, "")
    stored = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')")
    ok("the new title is persisted", any(c.get("name") == "数学冲刺" for c in stored), stored)
    cards_now = page.evaluate(CARDS)
    ok("renaming did not maximise the card", len(cards_now) == len(start) - 1 and any(c["kind"] == "group" for c in cards_now),
       [c["id"] for c in cards_now])
    page.screenshot(path=SHOTS + "/v8_04_renamed.png")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-group", timeout=15000)
    page.wait_for_timeout(2200)
    ok("the new title survives a reload", page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)") == ["数学冲刺"],
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)"))
    # Escape cancels, blur saves
    page.dblclick(".kg-group .kg-gname")
    page.wait_for_timeout(300)
    page.fill(".kg-gname-edit", "临时")
    page.keyboard.press("Escape")
    page.wait_for_timeout(320)
    ok("Escape cancels the rename",
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)") == ["数学冲刺"],
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)"))
    page.dblclick(".kg-group .kg-gname")
    page.wait_for_timeout(300)
    page.fill(".kg-gname-edit", "回归组")
    # click another card's title row: real pointerdown outside the editor, and the
    # gesture that follows has no movement so nothing is dragged
    other = page.evaluate(CARDS)
    other = [c for c in other if c["kind"] != "group"][0]
    osel = '.kg-surface > .kg-panel[data-prof="%s"] .kg-phead' % other["id"]
    page.click(osel)
    page.wait_for_timeout(420)
    ok("clicking away saves the rename",
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)") == ["回归组"],
       page.eval_on_selector_all(".kg-gname", "e => e.map(x => x.textContent)"))
    page.screenshot(path=SHOTS + "/v8_05_rename_after_reload.png")

    real_bad = [b for b in bad if not b.startswith("401 http://127.0.0.1:9119/api/auth/me")
                and "/dashboard-plugins/example/" not in b]
    real_err = [e for e in errors if "Failed to load resource" not in e]
    ok("no plugin page errors", not real_err, real_err[:4])
    ok("no unexpected api failures", not real_bad, real_bad[:5])
    browser.close()

print("\n".join(notes))
print()
if fails:
    print("FAILURES (%d):" % len(fails))
    print("\n".join(fails))
    sys.exit(1)
print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))
