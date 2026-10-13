#!/usr/bin/env python
"""Headless acceptance for kanban-graph v12 (2026-10-11 round 2).

Two asks this round:
  1 空卡片货架=内容宽紧贴流式（该断言在 kg_v10_hl.py 的 v12 段里）
  2 分组嵌套：拖组到组上=组合中的组合；嵌套渲染/拖出/解散/防环/持久化

本探针专打嵌套全链路：SEED 里直接注入 壳组nA(含 §nB)、核组nB(含两个环引
用 §nA 与悬空 §ghost —— sanitizer 必须斩断)，野组nZ 做拖拽素材。

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v12_hl.py
"""
import atexit
import json
import os

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

GROUPS_JSON = json.dumps([
    {"id": "nA", "name": "壳组", "members": ["deskpet", "edu-qa", "\u00a7nB"], "inner": {}},
    {"id": "nB", "name": "核组", "members": ["jl-draft", "jl-voice", "\u00a7nA", "\u00a7ghost"], "inner": {}},
    {"id": "nZ", "name": "野组", "members": ["jrmath-lab", "jrphys-lab"], "inner": {}},
], ensure_ascii=False)

SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv12')) return;
    sessionStorage.setItem('__kgv12', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.setItem(K + 'grid', '0');
    localStorage.setItem(K + 'groups.__all__', %s);
    localStorage.setItem(K + 'layout.__all__', JSON.stringify({
      '@gnA': { x: 20, y: 20, w: 840, h: 600 },
      '@gnZ': { x: 900, y: 20, w: 500, h: 600 }
    }));
    localStorage.removeItem(K + 'maxed.__all__');
    localStorage.removeItem(K + 'hiddenProfiles');
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf(K + 'miniPos.') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
})();
""" % json.dumps(GROUPS_JSON)

TOPCARDS = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-prof'), kind: el.classList.contains('kg-group') ? 'group' : 'prof',
           x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})"""

STORE = """() => JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')"""


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


def ghead_xy(page, gid):
    b = page.query_selector('.kg-group[data-group="%s"] > .kg-ghead' % gid).bounding_box()
    return (b["x"] + 40, b["y"] + b["height"] / 2)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors = []
    # 只算真故障：pageerror 与 5xx；401/404 是后台偶发资源请求（其它探针同样口径）
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text)
            if m.type == "error" and "401" not in m.text and "404" not in m.text
            and not m.text.startswith("Failed to load resource") else None)  # v18b: WSL net blips

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_selector(".kg-group", timeout=15000)
    page.wait_for_timeout(2600)

    # ── 1. seeded nesting renders, cycle + dangling tokens cut ──
    ok("no page errors on boot", not errors, errors[:3])
    nest = page.evaluate("""() => !!document.querySelector(
        '.kg-group[data-group="nA"] > .kg-gbody .kg-group[data-group="nB"]')""")
    ok("nested group renders INSIDE the parent body", nest, None)
    deep = page.evaluate("""() => document.querySelectorAll('.kg-group[data-group="nB"] .kg-group').length""")
    ok("cycle token §nA was cut (nB holds no group)", deep == 0, deep)
    nA_top = page.evaluate("""() => !!document.querySelector('.kg-surface > .kg-group[data-group="nA"]')""")
    ok("the parent of a nest is still a top-level card", nA_top, None)
    # regression lock (walkOwner bug 2026-10-11): a nested group must NEVER
    # also render as its own top-level card — items and DOM agree, no dupes
    dbl = page.evaluate("""() => {
      const n = window.__KG_NEST__ || { items: [] };
      const gi = n.items.filter(i => i.indexOf('@g') === 0);
      const top = Array.from(document.querySelectorAll('.kg-surface > .kg-group')).map(g => g.getAttribute('data-group'));
      return { gi: gi.sort(), top: top.sort() };
    }""")
    ok("items and wall show the same group set", dbl["gi"] == ["@g" + t for t in dbl["top"]], dbl)
    ok("no duplicate top-level cards", len(dbl["top"]) == len(set(dbl["top"])), dbl["top"])
    zInBody = page.evaluate("""() => !!document.querySelector('.kg-surface > .kg-group[data-group="nZ"]')""")
    ok("the un-nested group stays top-level", zInBody, None)

    # direct-member count on the shell header: deskpet + edu-qa + 1 nested group
    gn = page.evaluate("""() => (document.querySelector('.kg-group[data-group="nA"] .kg-gn')||{}).textContent""")
    ok("shell header counts DIRECT members (3: 2 profs + 1 group)", str(gn).strip() == "3", gn)

    # nested card sits geometrically inside the parent body box
    geo = page.evaluate("""() => {
      const p = document.querySelector('.kg-group[data-group="nA"] .kg-gbody').getBoundingClientRect();
      const c = document.querySelector('.kg-group[data-group="nA"] .kg-group[data-group="nB"]').getBoundingClientRect();
      return { inX: c.left >= p.left - 2 && c.right <= p.right + 2,
               inY: c.top >= p.top - 2 && c.bottom <= p.bottom + 2,
               h: Math.round(c.height), min: 230 };
    }""")
    ok("nested card fits inside the parent body", geo["inX"] and geo["inY"], geo)
    ok("nested card is a real card (>= GMIN_H when busy)", geo["h"] >= geo["min"] - 2, geo)

    # nested member cards carry data-in-group of their PARENT
    dig = page.evaluate("""() => {
      const q = document.querySelectorAll('.kg-group[data-group="nB"] > .kg-gbody .kg-panel');
      return Array.from(q).every(p => p.getAttribute('data-in-group') === 'nB');
    }""")
    ok("profiles of the inner group are tagged data-in-group=nB", dig, None)
    page.screenshot(path=SHOTS + "/v12_01_seeded_nest.png")

    # ── 2. persistence round-trip: reload keeps the nest, no dup parents ──
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-group", timeout=15000)
    page.wait_for_timeout(2400)
    nest2 = page.evaluate("""() => !!document.querySelector(
        '.kg-group[data-group="nA"] > .kg-gbody .kg-group[data-group="nB"]')""")
    ok("nest survives a reload", nest2, None)

    # ── 3. drag nZ onto the shell = NEST it (the round's ask) ──
    fx, fy = ghead_xy(page, "nZ")
    tx, ty = ghead_xy(page, "nA")
    drag(page, (fx, fy), (tx, ty))
    st = page.evaluate(STORE)
    gA = [g for g in st if g["id"] == "nA"][0]
    ok("store: nA.members grew a §nZ token", "\u00a7nZ" in gA["members"], gA["members"])
    ztop = page.evaluate("""() => !!document.querySelector('.kg-surface > .kg-group[data-group="nZ"]')""")
    ok("nZ is no longer a wall card after nesting", not ztop, None)
    znest = page.evaluate("""() => !!document.querySelector('.kg-group[data-group="nA"] .kg-group[data-group="nZ"]')""")
    ok("nZ now renders inside the shell body", znest, None)
    gn3 = page.evaluate("""() => (document.querySelector('.kg-group[data-group="nA"] .kg-gn')||{}).textContent""")
    ok("shell header count grew to 4", str(gn3).strip() == "4", gn3)
    page.screenshot(path=SHOTS + "/v12_02_nested_by_drag.png")

    # ── 4. nested gauto: the whole subtree re-tiles ──
    # dirty the inner first (drag a nested profile), then hit 自动排列 on nA
    dirty = page.evaluate("""() => {
      const p = document.querySelector('.kg-group[data-group="nB"] > .kg-gbody .kg-panel .kg-phead');
      if (!p) return false; const b = p.getBoundingClientRect();
      return { x: b.x + 30, y: b.y + b.height / 2 };
    }""")
    if dirty:
        drag(page, (dirty["x"], dirty["y"]), (dirty["x"] + 30, dirty["y"] + 30))
    inner_before = page.evaluate(STORE)
    clicked = page.evaluate("""() => {
      const b = Array.from(document.querySelectorAll('.kg-group[data-group="nA"] .kg-gauto'));
      if (!b.length) return false; b[0].click(); return true;
    }""")
    page.wait_for_timeout(600)
    ok("shell auto-arrange button clickable", clicked, None)
    st2 = page.evaluate(STORE)
    byId = {g["id"]: g for g in st2}
    ok("auto-arrange cleared the shell inner", byId["nA"]["inner"] == {}, byId["nA"]["inner"])
    ok("auto-arrange cleared the DESCENDANT inner too", byId["nB"]["inner"] == {}, byId["nB"]["inner"])

    # ── 5. pull a nested group out by dragging onto empty wall ──
    # find an empty wall point well right/below the cards
    spot = page.evaluate("""() => {
      const rects = Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group'))
        .map(e => e.getBoundingClientRect());
      const surf = document.querySelector('.kg-surface').getBoundingClientRect();
      for (let y = surf.bottom - 60; y > 80; y -= 20)
        for (let x = surf.right - 60; x > 20; x -= 20)
          if (!rects.some(r => x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6))
            return { x: x, y: y };
      return null;
    }""")
    ok("found an empty wall spot to extract into", bool(spot), spot)
    b = page.query_selector('.kg-group[data-group="nA"] .kg-group[data-group="nB"] > .kg-ghead').bounding_box()
    drag(page, (b["x"] + 40, b["y"] + b["height"] / 2), (spot["x"], spot["y"]))
    st3 = page.evaluate(STORE)
    byId3 = {g["id"]: g for g in st3}
    ok("store: parent lost the §nB token", "\u00a7nB" not in byId3["nA"]["members"], byId3["nA"]["members"])
    zt = page.evaluate("""() => !!document.querySelector('.kg-surface > .kg-group[data-group="nB"]')""")
    ok("pulled-out group is a top-level card again", zt, None)
    keep = page.evaluate("""() => {
      const g = document.querySelector('.kg-group[data-group="nB"]');
      return g ? Array.from(g.querySelectorAll(':scope > .kg-gbody > .kg-panel')).length : 0;
    }""")
    ok("the extracted group kept its two profiles", keep == 2, keep)
    page.screenshot(path=SHOTS + "/v12_03_extracted.png")

    # ── 6. dissolving the shell frees ITS direct members but the inner group
    #        that was extracted earlier is independent; re-nest nZ into nA then
    #        dissolve nA -> nZ must survive as a top-level card (one-level cut)
    page.evaluate("""() => {
      const g = document.querySelector('.kg-group[data-group="nZ"]');
      g && g.dispatchEvent(new Event('noop'));
    }""")
    fx2, fy2 = ghead_xy(page, "nZ")
    tx2, ty2 = ghead_xy(page, "nA")
    drag(page, (fx2, fy2), (tx2, ty2))
    st4 = page.evaluate(STORE)
    nested_now = any("\u00a7nZ" in g["members"] for g in st4)
    ok("re-nested nZ into the shell for the dissolve test", nested_now, st4)
    try:
        page.locator('.kg-surface > .kg-group[data-group="nA"] > .kg-ghead > .kg-gx').click(timeout=5000)
        gone = True
    except Exception as _e:
        gone = False
    # React 状态落地有 40ms debounce + 网络回写，轮询而非定值等待
    st5 = page.evaluate(STORE)
    for _ in range(12):
        page.wait_for_timeout(250)
        st5 = page.evaluate(STORE)
        if not any(g["id"] == "nA" for g in st5):
            break
    ok("shell dissolve button clicked", gone, None)
    ids5 = {g["id"] for g in st5}
    ok("dissolved shell is gone from the store", "nA" not in ids5, ids5)
    ok("the nested nZ SURVIVED the dissolve as its own group", "nZ" in ids5, ids5)
    zfree = page.evaluate("""() => !!document.querySelector('.kg-surface > .kg-group[data-group="nZ"]')""")
    ok("nZ renders top-level again after the dissolve", zfree, None)
    aFreed = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel'))
        .filter(p => ['deskpet','edu-qa'].includes(p.getAttribute('data-prof'))).length""")
    ok("the shell's profile members became free cards", aFreed == 2, aFreed)

    # ── 7. wall still sane: no overlaps among top-level cards, no page errors
    tc = page.evaluate(TOPCARDS)
    ov = overlaps(tc)
    ok("no overlapping top-level cards after the whole suite", not ov, ov[:6])
    ok("no page errors during the suite", not errors, errors[:3])
    page.screenshot(path=SHOTS + "/v12_04_final.png")

    # ── 8. corrupt-store defence: two parents claim the same child ──
    page.evaluate("""() => {
      const K = 'hermes.kanbangraph.';
      localStorage.setItem(K + 'groups.__all__', JSON.stringify([
        {id: 'p1', name: '甲组', members: ['deskpet', 'edu-qa', '\\u00a7dup'], inner: {}},
        {id: 'dup', name: '被抢的组', members: ['jl-draft', 'jl-voice'], inner: {}},
        {id: 'p2', name: '乙组', members: ['jrmath-lab', 'jrphys-lab', '\\u00a7dup'], inner: {}}
      ]));
      // NOTE: do NOT clear the SEED sessionStorage marker — the init script
      // must NOT re-run and clobber this store on reload
    }""")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(".kg-group", timeout=15000)
    page.wait_for_timeout(2200)
    in_p1 = page.evaluate("""() => !!document.querySelector('.kg-group[data-group="p1"] .kg-group[data-group="dup"]')""")
    in_p2 = page.evaluate("""() => !!document.querySelector('.kg-group[data-group="p2"] .kg-group[data-group="dup"]')""")
    ok("duplicate parent: first reference wins", in_p1 and not in_p2, (in_p1, in_p2))
    ok("no page errors on the corrupt-store case", not errors, errors[:3])
    page.screenshot(path=SHOTS + "/v12_05_first_parent_wins.png")

    # leave the store clean for the probes that run after this one in the chain
    page.evaluate("""() => {
      const K = 'hermes.kanbangraph.';
      ['groups.__all__', 'layout.__all__', 'maxed.__all__', 'hiddenProfiles', 'hideSt'].forEach(k => localStorage.removeItem(K + k));
      Object.keys(localStorage).forEach(k => { if (k.indexOf(K + 'miniPos.') === 0) localStorage.removeItem(k); });
    }""")

    browser.close()
