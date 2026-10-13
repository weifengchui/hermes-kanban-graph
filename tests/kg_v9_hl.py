#!/usr/bin/env python
"""Headless acceptance for kanban-graph v9 (2026-10-11 round).

Covers the four asks:
  1 每张卡片头部有「自动排列」按钮（profile 卡 + 分组卡）
  2 双击任务块 → 任务详情弹窗（后端 /task，Esc / 点背景关闭）
  3 拖动时出现参考格子（多 profile 墙 8px+40px；单板节点格 306x76），带开关
  4 分组「自动排列」/ 默认布局：有任务块的成员放大、无任务块的缩小

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v9_hl.py
"""
import atexit
import os
import sys

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright  # noqa: E402

fails, notes = [], []


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


def _dump():
    # fires even when an assertion crashes the driver halfway through
    print("\n".join(notes))
    print()
    if fails:
        print("FAILURES (%d):" % len(fails))
        print("\n".join(fails))
    else:
        print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))


atexit.register(_dump)


def head6(s):
    return (s or "").replace("\u2026", "").strip()[:6]


SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv9')) return;
    sessionStorage.setItem('__kgv9', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'selectedBoard', 'edu');
    localStorage.setItem(K + 'crossEdges', '1');
    localStorage.setItem(K + 'grid', '1');
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

MEMBERS = """() => {
  const out = [];
  document.querySelectorAll('.kg-surface > .kg-group').forEach(g => {
    const body = g.querySelector('.kg-gbody').getBoundingClientRect();
    g.querySelectorAll('.kg-panel').forEach(p => {
      const r = p.getBoundingClientRect();
      out.push({ gid: g.getAttribute('data-group'), prof: p.getAttribute('data-prof'),
                 n: parseInt((p.querySelector('.kg-pcount') || {}).textContent || '0', 10) || 0,
                 x: Math.round(r.x - body.x), y: Math.round(r.y - body.y),
                 w: Math.round(r.width), h: Math.round(r.height),
                 inBody: r.left >= body.left - 1 && r.top >= body.top - 1 &&
                         r.right <= body.right + 1 && r.bottom <= body.bottom + 1 });
    });
  });
  return out;
}"""

GRIDINFO = """() => Array.from(document.querySelectorAll('.kg-grid')).map(e => ({
  cls: e.className, size: getComputedStyle(e).backgroundSize }))"""

NODES = """(prof) => {
  const p = document.querySelector('.kg-surface > .kg-panel[data-prof="' + prof + '"]');
  if (!p) return [];
  return Array.from(p.querySelectorAll('svg.kg-mini g.kg-node')).map(g => {
    const r = g.getBoundingClientRect();
    const t = Array.from(g.querySelectorAll('text.kg-title tspan')).map(s => s.textContent).join('');
    return { tip: (g.querySelector('title') || {}).textContent || '', ttl: t,
             x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
  });
}"""

MODAL = """() => {
  const m = document.querySelector('.kg-modal');
  if (!m) return null;
  return { title: (m.querySelector('.kg-mtitle') || {}).textContent || '',
           rows: m.querySelectorAll('.kg-mrow').length,
           secs: Array.from(m.querySelectorAll('.kg-msec > h4')).map(h => h.textContent),
           chips: Array.from(m.querySelectorAll('.kg-mmeta .kg-chip')).map(c => c.textContent),
           note: (m.querySelector('.kg-mnote') || {}).textContent || '',
           box: !!m.querySelector('.kg-mbox') };
}"""

CLICK_BTN = """(label) => {
  const b = Array.from(document.querySelectorAll('.kg-top button, .kg-top [role="button"]'))
    .find(x => (x.textContent || '').trim() === label);
  if (b) { b.click(); return true; }
  return false;
}"""


def overlaps(cards):
    out = []
    for i in range(len(cards)):
        for j in range(i + 1, len(cards)):
            a, b = cards[i], cards[j]
            if not (a["x"] + a["w"] <= b["x"] + 1 or b["x"] + b["w"] <= a["x"] + 1 or
                    a["y"] + a["h"] <= b["y"] + 1 or b["y"] + b["h"] <= a["y"] + 1):
                out.append("%s/%s" % (a["id"], b["id"]))
    return out


def drag(page, a, b, steps=12):
    page.mouse.move(a[0], a[1])
    page.mouse.down()
    for k in range(1, steps + 1):
        page.mouse.move(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps)
        page.wait_for_timeout(22)
    page.mouse.up()
    page.wait_for_timeout(340)


def head_xy(page, sel):
    b = page.query_selector(sel + " .kg-phead, " + sel + " .kg-ghead").bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors, bad, taskcalls = [], [], []
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)
    page.on("response", lambda r: bad.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)
    page.on("response", lambda r: taskcalls.append(r.status) if "/kanban-graph/task?" in r.url else None)

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(3200)

    cards = page.evaluate(CARDS)
    ok("no cards overlap at first paint", not overlaps(cards), overlaps(cards))

    # ── 1. 自动排列 on every card ──
    pauto = page.eval_on_selector_all(".kg-surface > .kg-panel .kg-pauto", "e => e.map(x => x.textContent)")
    ok("every profile card carries an 自动排列 button",
       len(pauto) == len([c for c in cards if c["kind"] == "prof"]) and all(t == "自动排列" for t in pauto),
       "%d buttons / %d cards" % (len(pauto), len(cards)))
    # Pick the card that actually draws task blocks. A wall card carries only the
    # dependency-relevant boxes (settled history is dropped by buildModel), so
    # "biggest by area" can land on a card with 1-2 boxes: on 2026-10-11 the
    # first card held 37 tasks yet drew 2 boxes, which made this assertion red
    # while nothing was broken. Rank by drawn boxes instead.
    prof_cards = [c for c in cards if c["kind"] == "prof"]
    drawn = {c["id"]: len(page.evaluate(NODES, c["id"])) for c in prof_cards}
    ok("the wall draws task blocks somewhere (data sanity for the block tests)",
       max(drawn.values() or [0]) >= 2, sorted(drawn.items(), key=lambda kv: -kv[1])[:4])
    big = max(prof_cards, key=lambda c: drawn[c["id"]])
    selbig = '.kg-surface > .kg-panel[data-prof="%s"]' % big["id"]
    # v11: the row-first wall is TALLER (2 columns on a 1440x900 probe viewport),
    # so the busiest card can sit below the fold — scroll it in before measuring,
    # otherwise the pointerdown lands outside the viewport and nothing drags.
    page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }", selbig)
    page.wait_for_timeout(160)

    nodes = page.evaluate(NODES, big["id"])
    ok("the target card is the one drawing the most blocks", len(nodes) == max(drawn.values()), len(nodes))
    n0 = nodes[0]
    drag(page, (n0["x"], n0["y"]), (n0["x"] + 24, n0["y"] + 16), steps=8)
    seeded = page.evaluate("(p) => localStorage.getItem('hermes.kanbangraph.miniPos.' + p)", big["id"])
    ok("dragging a block inside a card stores a manual position", bool(seeded), seeded)

    before = [c for c in page.evaluate(CARDS) if c["id"] == big["id"]][0]
    page.hover(selbig)
    page.click(selbig + " .kg-pauto")
    page.wait_for_timeout(520)
    gone = page.evaluate("(p) => localStorage.getItem('hermes.kanbangraph.miniPos.' + p)", big["id"])
    ok("卡片自动排列 clears the manual block positions", gone is None, gone)
    after = [c for c in page.evaluate(CARDS) if c["id"] == big["id"]][0]
    ok("卡片自动排列 resizes the card to its content",
       after["w"] % 8 == 0 and after["h"] % 8 == 0 and (after["w"], after["h"]) != (before["w"], before["h"]),
       "before=%sx%s after=%sx%s" % (before["w"], before["h"], after["w"], after["h"]))
    ok("no cards overlap after a card 自动排列", not overlaps(page.evaluate(CARDS)), overlaps(page.evaluate(CARDS)))
    page.screenshot(path=SHOTS + "/v9_01_card_arrange.png")

    # ── 4. group 自动排列 weights members by VISIBLE blocks ──
    # The v9 contract is 空=1 / 有块=3 — it is NOT proportional to the block
    # count, so two busy members of 11 and 9 blocks are supposed to be the SAME
    # size (the old witness picked exactly that pair and red-flagged a contract
    # it never tested). A legal witness is one BUSY card + one EMPTY card, and
    # live data has no empty profile right now: empty one on purpose by hiding
    # the single status all of its blocks carry (same trick as kg_v10_hl).
    st_map = page.evaluate("""() => {
      const out = {};
      document.querySelectorAll('.kg-surface > .kg-panel').forEach(p => {
        out[p.getAttribute('data-prof')] = Array.from(p.querySelectorAll('.kg-node')).map(n => {
          const m = /kg-s-([a-zA-Z_-]+)/.exec(n.getAttribute('class') || '');
          return m ? m[1] : '';
        }).filter(Boolean);
      });
      return out;
    }""")
    pick = None
    # the emptied witness must stay empty AND the busy witness must SURVIVE the
    # same hidden status (both cards collapsed on the first attempt — hiding one
    # status can empty several single-status profiles at once)
    for k, ss in sorted(st_map.items(), key=lambda z: -len(z[1])):
        if not ss or len(set(ss)) != 1:
            continue
        s_status = ss[0]
        survivors = [b for b in st_map if b != k and set(st_map[b]) - {s_status}]
        if not survivors:
            continue
        survivors.sort(key=lambda b: -len(st_map[b]))
        pick = (survivors[0], k, s_status); break
    hide_status = pick[2] if pick else None
    if pick:
        page.evaluate("([s]) => localStorage.setItem('hermes.kanbangraph.hideSt', JSON.stringify([s]))", [hide_status])
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
        page.wait_for_timeout(1000)
    ok("见证合法：一张有块卡 + 一张被清空的卡", bool(pick), pick)
    live = page.evaluate(CARDS)
    if pick:
        small = next((c for c in live if c["kind"] == "prof" and c["id"] == pick[1]), None)
        big2 = next((c for c in live if c["kind"] == "prof" and c["id"] == pick[0]), None)
    else:
        by_area = sorted([c for c in live if c["kind"] == "prof"], key=lambda c: c["w"] * c["h"])
        small, big2 = by_area[0], by_area[-1]
    ok("清空后的见证卡确实画不出块（非空转前提）",
       bool(pick) and small is not None and big2 is not None, (pick, bool(small), bool(big2)))
    counts = page.evaluate("""(ids) => ids.map(i => {
      const p = document.querySelector('.kg-surface > .kg-panel[data-prof="' + i + '"]');
      if (!p) return -1;
      return parseInt((p.querySelector('.kg-pcount') || {}).textContent || '0', 10) || 0;
    })""", [small["id"], big2["id"]]) if (small and big2) else [-1, -1]
    ok("the two grouping candidates differ in VISIBLE blocks", counts[0] != counts[1],
       dict(zip([small["id"], big2["id"]], counts)) if (small and big2) else counts)
    # put the SOURCE card on screen (earlier playwright clicks auto-scrolled the
    # wall; stale viewport coords would make pointerdown miss) and re-measure
    # both ends after the scroll
    page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start' }); }",
                  '.kg-surface > .kg-panel[data-prof="%s"]' % small["id"])
    page.wait_for_timeout(160)
    live2 = page.evaluate(CARDS)
    small = [c for c in live2 if c["id"] == small["id"]][0]
    big2 = [c for c in live2 if c["id"] == big2["id"]][0]
    drag(page, head_xy(page, '.kg-surface > .kg-panel[data-prof="%s"]' % small["id"]),
         (big2["x"] + big2["w"] / 2, big2["y"] + big2["h"] / 2))
    page.wait_for_timeout(520)
    mem = page.evaluate(MEMBERS)
    ok("dragging a card onto another forms a group", len(mem) == 2, mem)
    ok("group members stay inside the group body", bool(mem) and all(m["inBody"] for m in mem), mem)
    if len(mem) == 2:
        busy = max(mem, key=lambda m: m["n"])
        idle = min(mem, key=lambda m: m["n"])
        ok("默认布局：任务多的成员更大",
           busy["n"] > idle["n"] and busy["w"] * busy["h"] > idle["w"] * idle["h"] * 1.2,
           "%s(%d)=%dx%d vs %s(%d)=%dx%d" % (busy["prof"], busy["n"], busy["w"], busy["h"],
                                             idle["prof"], idle["n"], idle["w"], idle["h"]))
    ga = page.eval_on_selector_all(".kg-group .kg-gauto", "e => e.map(x => x.textContent)")
    ok("the group card carries an 自动排列 button", ga == ["\u81ea\u52a8\u6392\u5217"], ga)

    gsel = ".kg-surface > .kg-group"
    page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start' }); }", gsel)
    page.wait_for_timeout(160)
    gm = page.query_selector(gsel + " .kg-ghead").bounding_box()
    # Drop target = the OPPOSITE half of the body from where the member's
    # panel currently sits, horizontally only (a member panel is as tall as
    # the body, so vertical manual offsets get clamped away), and clamped to
    # the viewport (tall groups push body.bottom under the fold; a pointer
    # target below the viewport silently cancels the drop — that produced
    # the deterministic [ {} ] flake). A fixed +190/+152 offset written when
    # edge-snap was still silently NaN later coincided with the member's own
    # flow slot and snapBack deleted the key; an opposite-half landing can
    # structurally never equal the member's own slot in either layout.
    gb = None
    _el = page.query_selector(gsel + " .kg-gbody")
    _b = _el.bounding_box() if _el else None
    if _b and "width" in _b and "height" in _b and _b["width"] > 0:
        gb = _b
    else:
        _r = page.evaluate(
            "() => { const e = document.querySelector('.kg-surface > .kg-group .kg-gbody');"
            " if (!e) return null; const b = e.getBoundingClientRect();"
            " return { x: b.x, y: b.y, width: b.width, height: b.height }; }")
        gb = _r if (_r and _r["width"] > 0) else gm
    _pnl = page.query_selector(gsel + " .kg-panel")
    P = _pnl.bounding_box() if _pnl else None
    vh = page.evaluate("() => window.innerHeight")
    left_half = P["x"] + P["width"] / 2 < gb["x"] + gb["width"] / 2
    tx = (gb["x"] + gb["width"] - P["width"] / 2 - 20) if left_half else (gb["x"] + P["width"] / 2 + 20)
    ty = min(P["y"] + 12, gb["y"] + gb["height"] - 40, vh - 60)
    drag(page, head_xy(page, gsel + " .kg-panel"), (tx, ty), steps=8)
    stored = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')")
    ok("dragging a member inside the group stores a manual rect",
       any((c.get("inner") or {}) for c in stored), [c.get("inner") for c in stored])
    page.hover(gsel)
    page.click(gsel + " .kg-gauto")
    page.wait_for_timeout(520)
    stored2 = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')")
    ok("分组自动排列 clears the manual member rects",
       bool(stored2) and all(not (c.get("inner") or {}) for c in stored2), [c.get("inner") for c in stored2])
    mem2 = page.evaluate(MEMBERS)
    ok("分组自动排列 keeps every member inside the group", bool(mem2) and all(m["inBody"] for m in mem2), mem2)
    if len(mem2) == 2:
        b2 = max(mem2, key=lambda m: m["n"])
        i2 = min(mem2, key=lambda m: m["n"])
        ok("分组自动排列：有任务块的放大、无任务块的缩小",
           b2["w"] * b2["h"] > i2["w"] * i2["h"] * 1.2,
           "%s(%d)=%dx%d vs %s(%d)=%dx%d" % (b2["prof"], b2["n"], b2["w"], b2["h"],
                                             i2["prof"], i2["n"], i2["w"], i2["h"]))
    page.screenshot(path=SHOTS + "/v9_02_group_arrange.png")

    # restore the full wall for the sections below (the deliberately emptied
    # witness card would otherwise starve the later block tests of data)
    if hide_status:
        page.evaluate("() => localStorage.setItem('hermes.kanbangraph.hideSt', '[]')")
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
        page.wait_for_timeout(1000)

    pure = page.evaluate("""() => {
      const I = window.__KG_TEST__, w0 = I.profWeight(0), wb = I.profWeight(8);
      const L = I.innerLayout(['e', 'b'], {}, { w: 600, h: 400 }, 6, [w0, wb]);
      const a = r => r.w * r.h;
      const hit = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      return { w0: w0, wb: wb, ratio: a(L.b) / a(L.e), L: L, hit: hit(L.e, L.b),
               inside: L.e.x >= 0 && L.e.y >= 0 && L.b.x + L.b.w <= 601 && L.b.y + L.b.h <= 401 };
    }""")
    ok("空 profile 权重=1、有任务块的=3", pure["w0"] == 1 and pure["wb"] == 3, (pure["w0"], pure["wb"]))
    ok("加权布局按权重分面积（空卡约为有卡卡的 1/3）", 2.4 <= pure["ratio"] <= 3.6, pure["ratio"])
    ok("加权布局不重叠且都在 body 内", (not pure["hit"]) and pure["inside"], pure["L"])

    # a manual member rect can land on top of the auto slots — the others must
    # then re-pack around it instead of stacking (v7 caught this on 2026-10-11)
    squeezed = page.evaluate("""() => {
      const I = window.__KG_TEST__, mem = ['a', 'b', 'c'], body = { w: 360, h: 341 };
      const w = [I.profWeight(36), I.profWeight(1), I.profWeight(4)];
      const L = I.innerLayout(mem, { a: { x: 39, y: 29, w: 215, h: 216 } }, body, 6, w);
      const hit = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      const bad = [];
      for (const x of mem) for (const y of mem) if (x < y && hit(L[x], L[y])) bad.push(x + '/' + y);
      const out = mem.filter(m => L[m].x < 0 || L[m].y < 0 ||
                                L[m].x + L[m].w > body.w + 1 || L[m].y + L[m].h > body.h + 1);
      return { bad: bad, out: out, L: L };
    }""")
    ok("手动摆放的成员压住槽位时其余成员重新排开（不叠放、不出界）",
       (not squeezed["bad"]) and (not squeezed["out"]), squeezed["L"])

    # ── 2. double-click a task block -> detail popup ──
    tgt = None
    for c in page.evaluate(CARDS):
        if c["kind"] != "prof":
            continue
        ns = page.evaluate(NODES, c["id"])
        if ns:
            tgt = (c["id"], ns[0])
            break
    ok("found a task block to double-click", tgt is not None, tgt and tgt[0])
    if tgt:
        prof, n = tgt
        nsel = '.kg-surface > .kg-panel[data-prof="%s"] svg.kg-mini g.kg-node' % prof
        page.dblclick(nsel)
        page.wait_for_selector(".kg-modal", timeout=8000)
        page.wait_for_timeout(800)
        md = page.evaluate(MODAL)
        ok("双击任务块弹出任务详情弹窗", bool(md and md["box"]), md)
        ok("弹窗标题即任务标题", bool(md and md["title"]) and head6(md["title"]) == head6(n["ttl"]),
           "%r vs block %r" % ((md or {}).get("title"), n["ttl"]))
        ok("弹窗带状态/板/指派等字段行", bool(md and md["rows"] >= 5), (md or {}).get("rows"))
        ok("弹窗展示了描述或依赖/事件分区", bool(md and md["secs"]), (md or {}).get("secs"))
        ok("弹窗胶囊含所属板", bool(md and any(str(c).startswith("板 ") for c in md["chips"])), (md or {}).get("chips"))
        ok("弹窗未报读取失败", not (md and md["note"].startswith("读取失败")), (md or {}).get("note"))
        ok("详情来自 /task 接口且返回 200", bool(taskcalls) and set(taskcalls) == {200}, taskcalls)
        page.screenshot(path=SHOTS + "/v9_03_task_modal.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(380)
        ok("Esc 关闭弹窗", page.eval_on_selector_all(".kg-modal", "e => e.length") == 0, "")
        page.dblclick(nsel)
        page.wait_for_selector(".kg-modal", timeout=8000)
        page.wait_for_timeout(900)
        mb = page.query_selector(".kg-mbox").bounding_box()
        # rebase (v18 triage): the modal centres itself and its async sections
        # (评论/事件) can GROW the box after we read it — the old blind click
        # 34px above the old top edge landed INSIDE the grown modal (clicked
        # 350,358 / box top 392, stayed open). Pick a candidate pixel and
        # VERIFY with elementFromPoint that it is outside .kg-mbox at click time.
        pt = page.evaluate("""(mb) => {
          const vw = innerWidth, vh = innerHeight;
          const cands = [[mb.x + mb.width / 2, mb.y - 26],
                         [mb.x - 28, mb.y + mb.height / 2],
                         [mb.x + mb.width + 28, mb.y + mb.height / 2],
                         [12, vh - 12]];
          for (const c of cands) {
            const x = c[0], y = c[1];
            if (x < 4 || y < 4 || x > vw - 6 || y > vh - 6) continue;
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest('.kg-mbox')) return { x: x, y: y };
          }
          return null;
        }""", mb)
        ok("背景关闭：找到弹窗外的可点位", bool(pt), mb)
        if pt:
            page.mouse.click(pt["x"], pt["y"])
        page.wait_for_timeout(420)
        closed = page.eval_on_selector_all(".kg-modal", "e => e.length") == 0
        ok("点弹窗背景关闭", closed, "clicked %s box=%s,%s" % (pt, round(mb["x"]), round(mb["y"])))
        if not closed:
            page.keyboard.press("Escape")
            page.wait_for_timeout(320)

    # ── 3. drag reference grid ──
    if page.eval_on_selector_all(".kg-modal", "e => e.length"):
        page.keyboard.press("Escape")
        page.wait_for_timeout(320)
    ok("静止时没有参考格子", page.eval_on_selector_all(".kg-surface > .kg-grid", "e => e.length") == 0, "")
    gc = [c for c in page.evaluate(CARDS) if c["kind"] == "group"]
    g = None
    # the pinned card (kg-pinner) floats above the wall and can cover heads —
    # pick the first candidate whose head-centre actually hits its own card
    for cand in gc + [c for c in page.evaluate(CARDS) if c["kind"] != "group"]:
        _sel = (".kg-surface > .kg-group[data-gid=\"%s\"]" % cand["id"] if cand["kind"] == "group"
                else '.kg-surface > .kg-panel[data-prof="%s"]' % cand["id"])
        try:
            _hx, _hy = head_xy(page, _sel)
        except Exception:
            continue
        _owner = page.evaluate("""(pt) => { const e=document.elementFromPoint(pt.x,pt.y); const c=e&&e.closest('.kg-panel,.kg-group'); return c? (c.getAttribute('data-prof')||c.getAttribute('data-gid')) : 'none'; }""", {"x": _hx, "y": _hy})
        if _owner == cand["id"]:
            g, hx, hy = cand, _hx, _hy
            break
    if g is None:
        g = page.evaluate(CARDS)[0]
    sel = ".kg-surface > .kg-group" if g["kind"] == "group" else '.kg-surface > .kg-panel[data-prof="%s"]' % g["id"]
    if g["kind"] == "group":
        sel = '.kg-surface > .kg-group[data-gid="%s"]' % g["id"]
    if "hx" not in dir():
        page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }", sel)
        page.wait_for_timeout(160)
        hx, hy = head_xy(page, sel)
    page.hover(sel)
    page.mouse.move(hx, hy)
    page.mouse.down()
    for k in range(1, 7):
        page.mouse.move(hx + k * 9, hy + k * 6)
        page.wait_for_timeout(30)
    grid = page.evaluate(GRIDINFO)
    ok("拖动过程中出现参考格子", len(grid) == 1, grid)
    ok("参考格子是 8px 细格 + 40px 主线",
       bool(grid) and "8px" in grid[0]["size"] and "40px" in grid[0]["size"], grid[0]["size"] if grid else "")
    page.screenshot(path=SHOTS + "/v9_04_drag_grid.png")
    page.mouse.up()
    page.wait_for_timeout(420)
    ok("松手后参考格子消失", page.eval_on_selector_all(".kg-grid", "e => e.length") == 0, "")

    page.evaluate(CLICK_BTN, "网格")
    page.wait_for_timeout(320)
    ok("网格开关写入 localStorage", page.evaluate("localStorage.getItem('hermes.kanbangraph.grid')") == "0", "")
    hx, hy = head_xy(page, sel)
    page.mouse.move(hx, hy)
    page.mouse.down()
    for k in range(1, 6):
        page.mouse.move(hx + k * 8, hy + k * 5)
        page.wait_for_timeout(30)
    ok("关掉开关后拖动不再画格子", page.eval_on_selector_all(".kg-surface > .kg-grid", "e => e.length") == 0, "")
    page.mouse.up()
    page.wait_for_timeout(320)
    page.evaluate(CLICK_BTN, "网格")
    page.wait_for_timeout(260)

    # snapping precision: hide the other profiles, then the drop must land on the 8px lattice
    free = [c for c in page.evaluate(CARDS) if c["kind"] == "prof"]
    keep = max(free, key=lambda c: c["w"] * c["h"])["id"]
    page.evaluate("""(keep) => {
      Array.from(document.querySelectorAll('.kg-top .kg-chips .kg-chip-btn')).forEach(b => {
        const t = (b.getAttribute('title') || '');
        if (/点击隐藏/.test(t) && t.split(' ')[0] !== keep) b.click();
      });
    }""", keep)
    page.wait_for_timeout(800)
    solo = page.evaluate(CARDS)
    ok("可以只留一张卡（吸附判据的前提）", len(solo) == 1 and solo[0]["id"] == keep, [c["id"] for c in solo])
    if len(solo) == 1:
        s = solo[0]
        ss = '.kg-surface > .kg-panel[data-prof="%s"]' % s["id"]
        # rebase (v18 chain2 red): v17 pins the first-computed wall geometry, so
        # the kept card sits at its ORIGINAL slot — below the fold (y=2342 in a
        # 637px viewport). The old drag was then a silent no-op and the snap
        # check read the untouched pin (12/2342, off-grid by fillWall design).
        # Scroll it into frame, remember the stored rect, and require the drag
        # to actually engage before judging the landing.
        page.evaluate("(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }", ss)
        page.wait_for_timeout(250)
        lay_pre = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}')")
        pre = lay_pre.get(s["id"])
        hx, hy = head_xy(page, ss)
        ok("solo 卡已滚进可拖区（吸附判据的前提）", bool(pre) and hy is not None and 60 <= hy <= 860, (hx, hy, pre))
        drag(page, (hx, hy), (hx + 101, hy + 61), steps=12)
        mv = [c for c in page.evaluate(CARDS) if c["id"] == s["id"]]
        ok("拖动后卡片仍在场上", len(mv) == 1, mv)
        if mv:
            # the persisted layout is in SURFACE coordinates — the viewport x is
            # offset by the plugin's own left edge, so compare the stored value.
            lay = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}')")
            got = lay.get(s["id"])
            ok("拖动后卡片落点写入布局", bool(got), lay)
            engaged = bool(got and pre) and (abs(got["x"] - pre["x"]) + abs(got["y"] - pre["y"])) > 20
            ok("拖拽真实生效（存位离开原槽）", engaged, (pre, got))
            if got and engaged:
                # snapMove's real contract: a MAGNET first (canvas 0/mid/end or a
                # neighbour's edge/centre within SNAP=8), and only when nothing
                # matched does the value round onto the 8px lattice. A v14 wall is
                # taller than the board, so a drop legitimately lands on a magnet
                # — "must be a multiple of 8" silently assumed magnets never fire.
                snap = page.evaluate("""(id) => {
                  const b = document.querySelector('.kg-board');
                  const C = { w: b.clientWidth, h: b.clientHeight };
                  const surf = document.querySelector('.kg-surface').getBoundingClientRect();
                  const others = Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group'))
                    .filter(e => e.getAttribute('data-prof') !== id)
                    .map(e => { const r = e.getBoundingClientRect();
                                return { x: r.x - surf.left, y: r.y - surf.top, w: r.width, h: r.height }; });
                  const tol = 8;
                  function good(v, size, axis) {
                    if (v % 8 === 0) return 'grid';
                    const t = [];
                    others.forEach(o => {
                      const p = axis === 'x' ? o.x : o.y, s2 = axis === 'x' ? o.w : o.h;
                      t.push(p, p + s2 / 2, p + s2);
                    });
                    const cc = axis === 'x' ? C.w : C.h;
                    t.push(0, cc / 2, cc);
                    const edges = [v, v + size / 2, v + size];
                    for (const e2 of edges) for (const tv of t) if (Math.abs(tv - e2) <= tol) return 'magnet@' + Math.round(tv);
                    return null;
                  }
                  const lay = JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__') || '{}');
                  const r = lay[id];
                  // v18b rebase: legal landings also include the wall's edge
                  // padding (PGAP=12 when a far drag clamps to the margin) and
                  // a drop whose bottom edge settles the SCROLLED surface
                  // (canvas grew under the card, so board.clientHeigbt lies).
                  const surfH = document.querySelector('.kg-surface').getBoundingClientRect().height;
                  const SH = Math.max(surfH, document.querySelector('.kg-surface').scrollHeight);
                  function pad(v, size) {
                    if (v <= 16) return 'pad@' + Math.round(v);
                    if (Math.abs(v + size - SH) <= 10) return 'surf-bottom';
                    return null;
                  }
                  const gx = good(r.x, r.w, 'x') || pad(r.x, r.w);
                  const gy = good(r.y, r.h, 'y') || pad(r.y, r.h);
                  return { x: gx, y: gy, cw: C.w, ch: C.h, others: others.length };
                }""", s["id"])
                ok("卡片落点是合法磁吸解（8px 格 或 画布/邻卡边与中线）",
                   bool(snap["x"]) and bool(snap["y"]), (got, snap))
        page.screenshot(path=SHOTS + "/v9_05_snap.png")

    # ── 3b. single-board lattice grid ──
    page.get_by_text("单板", exact=True).first.click()
    page.wait_for_timeout(3200)
    ok("单板视图也有网格开关",
       page.evaluate("""() => Array.from(document.querySelectorAll('.kg-top button, .kg-top [role="button"]'))
                        .some(x => (x.textContent || '').trim() === '网格')"""), "")
    ok("单板静止时没有参考格子", page.eval_on_selector_all(".kg-canvas > .kg-grid", "e => e.length") == 0, "")
    nb = page.query_selector("svg.kg-svg g.kg-node").bounding_box()
    nx, ny = nb["x"] + nb["width"] / 2, nb["y"] + nb["height"] / 2
    page.mouse.move(nx, ny)
    page.mouse.down()
    for k in range(1, 7):
        page.mouse.move(nx + k * 18, ny + k * 10)
        page.wait_for_timeout(30)
    lg = page.evaluate("""() => Array.from(document.querySelectorAll('.kg-canvas > .kg-grid')).map(e => ({
      cls: e.className, size: getComputedStyle(e).backgroundSize }))""")
    ok("单板拖动节点时出现参考格子", len(lg) == 1, lg)
    ok("单板格子即节点链格（306x76）",
       bool(lg) and lg[0]["size"].split(",")[0].strip() == "306px 76px", lg)
    page.screenshot(path=SHOTS + "/v9_06_single_grid.png")
    page.mouse.up()
    page.wait_for_timeout(420)
    ok("单板松手后格子消失", page.eval_on_selector_all(".kg-canvas > .kg-grid", "e => e.length") == 0, "")

    real_bad = [b for b in bad if not b.startswith("401 http://127.0.0.1:9119/api/auth/me")
                and "/dashboard-plugins/example/" not in b]
    real_err = [e for e in errors if "Failed to load resource" not in e]
    ok("no plugin page errors", not real_err, real_err[:4])
    ok("no unexpected api failures", not real_bad, real_bad[:5])
    browser.close()

sys.exit(1 if fails else 0)
