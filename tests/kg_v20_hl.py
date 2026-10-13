#!/usr/bin/env python
"""Headless acceptance for kanban-graph v20 (2026-10-12): fullscreen card area.

Asks this round (user):
  卡片区域允许全屏；全屏时其他信息都隐藏，只显示卡片区域。完成后就提交

Mechanism: the PAGE ROOT (.kg-fsroot) is the fullscreen element. While
fullscreen, CSS hides .kg-top (both views' toolbars) and .kg-status-bar, and
the inner .kg-root fills 100vh. A floating .kg-fs-exit chip exits; Esc also
exits natively. Single-board view re-fits the graph on fullscreenchange.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v20_hl.py
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
    print("\n".join(notes))
    print()
    if fails:
        print("FAILURES (%d):" % len(fails))
        print("\n".join(fails))
    else:
        print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))


atexit.register(_dump)

SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv20')) return;
    sessionStorage.setItem('__kgv20', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'hideSt', '[]');
  } catch (e) {}
})();
"""


def wait_fullscreen(page, want):
    """poll until (document.fullscreenElement is .kg-fsroot) == want"""
    t0 = page.evaluate("Date.now()")
    while True:
        got = page.evaluate(
            "!!(document.fullscreenElement && document.fullscreenElement.classList.contains('kg-fsroot'))"
        )
        if got == want:
            return True
        if page.evaluate("Date.now()") - t0 > 8000:
            return False
        page.wait_for_timeout(120)


def toolbar_fs_button(page):
    for b in page.query_selector_all("button"):
        try:
            t = (b.inner_text() or "").strip()
        except Exception:
            continue
        bb = b.bounding_box()
        if t == "全屏" and bb:
            return b
    return None


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    errors = []
    bad = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # same whitelist as kg_multi_hl: the SPA session probe answers 401 pre-login (host noise)
    page.on("response", lambda r: bad.append("%s %s" % (r.status, r.url))
            if r.status >= 400 and "/api/" in r.url else None)
    page.goto(BASE + "/kanban-graph", wait_until="networkidle")
    page.evaluate(SEED)
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1200)

    # ── multi view ──
    btn = toolbar_fs_button(page)
    ok("T1 multi toolbar has 全屏 button", btn is not None)
    if not btn:
        sys.exit(1)

    # before: chrome visible
    vis_before = page.evaluate(
        "getComputedStyle(document.querySelector('.kg-top')).display + '|' + "
        "document.querySelectorAll('.kg-status-bar').length"
    )
    ok("T2 non-fullscreen shows toolbar (no status bar: removed v20.3)",
       vis_before.startswith("flex|0"), vis_before)

    btn.click()
    ok("T3 click enters fullscreen on page root", wait_fullscreen(page, True))
    page.wait_for_timeout(900)  # let ResizeObserver re-plan the wall

    fs_state = page.evaluate("""() => {
      const top = document.querySelector('.kg-root.kg-fsroot .kg-top .kg-brand')
        ? document.querySelectorAll('.kg-root.kg-fsroot > .kg-root > .kg-top').length : -1;
      const tops = Array.from(document.querySelectorAll('.kg-fsroot .kg-top'));
      const bars = Array.from(document.querySelectorAll('.kg-fsroot .kg-status-bar'));
      const hidden = tops.every(el => getComputedStyle(el).display === 'none')
                  && bars.every(el => getComputedStyle(el).display === 'none');
      const board = document.querySelector('.kg-board');
      const bb = board ? board.getBoundingClientRect() : null;
      const chip = document.querySelector('.kg-fs-exit');
      const cb = chip ? chip.getBoundingClientRect() : null;
      const root = document.querySelector('.kg-fsroot');
      const rb = root ? root.getBoundingClientRect() : null;
      return {
        hidden: hidden,
        tops: tops.length, bars: bars.length,
        bw: bb ? bb.width : 0, bh: bb ? bb.height : 0,
        vw: innerWidth, vh: innerHeight,
        chipVisible: !!cb && cb.width > 20 && cb.height > 10,
        rootW: rb ? rb.width : 0, rootH: rb ? rb.height : 0
      };
    }""")
    ok("T4 toolbar hidden in fullscreen", fs_state["hidden"], fs_state)
    ok("T5 card area fills the screen", fs_state["bw"] >= fs_state["vw"] * 0.95
       and fs_state["bh"] >= fs_state["vh"] * 0.9, fs_state)
    ok("T6 root == viewport box (no letterbox)",
       abs(fs_state["rootW"] - fs_state["vw"]) <= 2 and abs(fs_state["rootH"] - fs_state["vh"]) <= 2, fs_state)
    ok("T7 exit chip visible in fullscreen", fs_state["chipVisible"])

    cards = page.evaluate("document.querySelectorAll('.kg-surface > .kg-panel').length")
    ok("T8 cards still rendered in fullscreen (non-vacuous)", cards >= 1, cards)
    page.screenshot(path=SHOTS + "/v20_multi_fullscreen.png")

    # exit via chip
    page.click(".kg-fs-exit")
    ok("T9 chip exits fullscreen", wait_fullscreen(page, False))
    page.wait_for_timeout(600)
    back = page.evaluate(
        "getComputedStyle(document.querySelector('.kg-root.kg-fsroot > .kg-root .kg-top')).display + '|' + "
        "!!document.querySelector('.kg-fs-exit')"
    )
    ok("T10 toolbar restored + chip gone after exit",
       back.startswith("flex|") and "true" not in back.lower(), back)

    # Esc exits too (native UA gesture)
    # Esc exit: the UA-level Esc shortcut is not reachable via CDP key events
    # in headless (browser-UI path). Emulate its exact downstream effect — an
    # external fullscreenchange — and assert state sync (chip gone, chrome back).
    btn = toolbar_fs_button(page)
    ok("T11 toolbar button re-found after exit (idempotent entry)", btn is not None)
    btn.click()
    ok("T11b re-enter fullscreen", wait_fullscreen(page, True))
    page.evaluate("document.exitFullscreen().catch(function(){})")
    ok("T12 external exit syncs state (Esc-equivalent)", wait_fullscreen(page, False))
    page.wait_for_timeout(600)
    back2 = page.evaluate(
        "getComputedStyle(document.querySelector('.kg-root.kg-fsroot > .kg-root > .kg-top')).display + '|' + "
        "!!document.querySelector('.kg-fs-exit')"
    )
    ok("T12b toolbar restored + chip gone after external exit",
       back2.startswith("flex|") and "true" not in back2.lower(), back2)

    # ── v20.1: pinned layout must SPREAD inside fullscreen (user report:
    # 全屏时右侧有空闲区域) and be byte-restored after exit ──
    import json as _json
    before = page.evaluate("localStorage.getItem('hermes.kanbangraph.layout.__all__')") or "{}"
    try:
        lay0 = _json.loads(before)
    except Exception:
        lay0 = {}
    ok("T21 wall auto-pinned before fullscreen (v17 pins in effect)", len(lay0) >= 4, len(lay0))
    btn = toolbar_fs_button(page)
    btn.click()
    ok("T22 enter fullscreen (pinned session)", wait_fullscreen(page, True))
    page.wait_for_timeout(1600)  # RO re-plan + transient pins settle
    spread = page.evaluate("""() => {
      const sb = document.querySelector('.kg-board').getBoundingClientRect();
      let maxR = 0, n = 0;
      document.querySelectorAll('.kg-surface > .kg-panel').forEach(el => {
        const b = el.getBoundingClientRect();
        if (b.width > 20) { maxR = Math.max(maxR, b.right - sb.left); n++; }
      });
      return { maxR, boardW: sb.width, n };
    }""")
    ok("T23 fullscreen spreads the wall to the right edge (>=92% board width)",
       spread["maxR"] >= spread["boardW"] * 0.92, spread)
    page.click(".kg-fs-exit")
    ok("T24 exit restores pinned session", wait_fullscreen(page, False))
    page.wait_for_timeout(900)
    after = page.evaluate("localStorage.getItem('hermes.kanbangraph.layout.__all__')") or "{}"
    same = False
    try:
        same = _json.loads(after) == lay0
    except Exception:
        same = False
    ok("T25 pinned layout byte-restored across the fullscreen cycle", same,
       (len(lay0), len(_json.loads(after) or {})))
    key0 = None
    for k in sorted(lay0):
        if k and isinstance(lay0[k], dict) and "x" in lay0[k] and not str(k).startswith("@g"):
            key0 = k
            break
    ok("T26a stored layout has a checkable prof rect", key0 is not None,
       sorted(lay0)[:6])
    rest = page.evaluate("""(k) => {
      const lay = JSON.parse(localStorage.getItem('hermes.kanbangraph.layout.__all__')||'{}');
      const el = document.querySelector('.kg-surface > .kg-panel[data-prof=\\'' + k + '\\']');
      if (!el) return { why: 'no-el', k: k, panels: document.querySelectorAll('.kg-surface > .kg-panel').length, keys: Object.keys(lay).length };
      if (!lay[k]) return { why: 'no-key', k: k };
      const sb = document.querySelector('.kg-board').getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { dx: (b.left - sb.left) - lay[k].x, dy: (b.top - sb.top) - lay[k].y };
    }""", key0) if key0 else None
    ok("T26 stored card back at its saved spot after exit",
       bool(rest) and "dx" in rest and abs(rest["dx"]) <= 3 and abs(rest["dy"]) <= 3, rest)

    # ── v20.3: status bar removed (user: 感觉没有太大价值，直接去掉) ──
    gone = page.evaluate("""() => ({
      bar: !!document.querySelector('.kg-status-bar'),
      items: document.querySelectorAll('.kg-sb-item').length,
      title: document.body.innerText.indexOf('会话运行状态') >= 0,
      panels: document.querySelectorAll('.kg-surface > .kg-panel').length,
      top: !!document.querySelector('.kg-top')
    })""")
    ok("S1 status bar fully removed (no node, no items, no text)",
       (not gone["bar"]) and gone["items"] == 0 and (not gone["title"]), gone)
    ok("S2 board still healthy (top bar + wall cards present)",
       bool(gone["top"]) and gone["panels"] >= 1, gone)

    comet = page.evaluate("""() => {
      const c = document.querySelector('.kg-comet');
      return c ? getComputedStyle(c).animationDuration : null;
    }""")
    ok("T30 comet slowed to 4.5s (user: 边框的光再慢一些)", comet == "4.5s", comet)

    # ── chip ↔ wall show/hide, now living on the filter row alone ──
    def prof_click(nm):
        page.evaluate(r"""(nm) => {
          const c = Array.from(document.querySelectorAll('.kg-chip'))
            .find(e => (e.textContent||'').trim().split(/\s/)[0] === nm);
          if (c) c.click();
        }""", nm)
        page.wait_for_timeout(500)
    def card_state(nm):
        return page.evaluate(r"""(nm) => ({
          wall: !!document.querySelector('.kg-surface > [data-prof="' + nm + '"]'),
          chipOff: !!Array.from(document.querySelectorAll('.kg-chip')).find(e =>
            (e.textContent||'').trim().split(/\s/)[0] === nm && e.className.includes('kg-chip-off'))
        })""", nm)
    c0 = card_state("study")
    ok("T31 study card present before toggling", c0["wall"] and not c0["chipOff"], c0)
    prof_click("study")
    c1 = card_state("study")
    ok("T32 chip click hides the card and dims the chip", (not c1["wall"]) and c1["chipOff"], c1)
    prof_click("study")
    c2 = card_state("study")
    ok("T33 chip click again restores it", c2["wall"] and not c2["chipOff"], c2)
    prof_click("study")
    page.reload(wait_until="networkidle")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=25000)
    page.wait_for_timeout(1200)
    c3 = card_state("study")
    ok("T34 hidden choice survives a reload", (not c3["wall"]) and c3["chipOff"], c3)
    prof_click("study")
    c4 = card_state("study")
    ok("T35 re-show works after reload too", c4["wall"] and not c4["chipOff"], c4)

    # ── single view ──
    for b in page.query_selector_all("button"):
        if (b.inner_text() or "").strip() == "单板":
            b.click()
            break
    page.wait_for_selector(".kg-canvas", timeout=20000)
    page.wait_for_timeout(1500)
    btn = toolbar_fs_button(page)
    ok("T13 single toolbar has 全屏 button", btn is not None)
    btn.click()
    ok("T14 single enters fullscreen", wait_fullscreen(page, True))
    page.wait_for_timeout(1000)  # re-fit lands at +60ms; give layout slack
    single = page.evaluate("""() => {
      const c = document.querySelector('.kg-canvas');
      const cb = c.getBoundingClientRect();
      const top = document.querySelector('.kg-root.kg-fsroot > .kg-root > .kg-top');
      return {
        cw: cb.width, ch: cb.height, vw: innerWidth, vh: innerHeight,
        topHidden: getComputedStyle(top).display === 'none'
      };
    }""")
    ok("T15 single canvas fills the screen", single["cw"] >= single["vw"] * 0.95
       and single["ch"] >= single["vh"] * 0.9, single)
    ok("T16 single toolbar hidden in fullscreen", single["topHidden"])
    page.screenshot(path=SHOTS + "/v20_single_fullscreen.png")
    page.click(".kg-fs-exit")
    ok("T17 single exits fullscreen", wait_fullscreen(page, False))

    # ── persistence: fullscreen must NOT leak into localStorage/state ──
    page.wait_for_timeout(400)
    leftover = page.evaluate(
        "Object.keys(localStorage).filter(k => k.toLowerCase().indexOf('fullscreen') >= 0).length"
    )
    ok("T18 no fullscreen state persisted (transient by design)", leftover == 0, leftover)

    ok("T19 no page errors", not errors, errors[:3])
    real_bad = [b for b in bad if not b.startswith("401 http://127.0.0.1:9119/api/auth/me")]
    ok("T20 no 4xx on /api/ (host /api/auth/me whitelisted)", not real_bad, real_bad[:3])

    browser.close()

sys.exit(1 if fails else 0)
