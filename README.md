# hermes-kanban-graph — **Board+**

A dashboard plugin for **Hermes Agent**: every Kanban task as a block, every
`parent → child` dependency as a wire, one card per profile, all on a single
draggable wall.

插件名就叫 `Board+`（中英文都是它，左侧 tab 也是这个名字）。Hermes 的仪表盘插件：把 Kanban 任务画成方块、把 `父 → 子` 依赖画成连线，每个 profile 一张卡片，
全部铺在一面可拖动的大屏上。

![wall](screenshots/01-wall.png)

---

## What it does · 功能

| | |
|---|---|
| **Dependency DAG** | Tasks are laid out on a lattice by topological depth; `parent → child` edges are drawn orthogonally, cycle-broken edges dashed. |
| **Multi-profile wall** 多 Profile 大屏 | One card per `assignee`. Drag, resize, magnet-snap to neighbours and to the 8 px lattice. Overlaps are resolved automatically (卡片互相排开). |
| **Card order** 卡片排序 | Cards that still draw task blocks come first, then by profile name (numeric suffixes compare numerically, unassigned last). Auto-arrange tiles in this order, so the busy profiles land top-left; a card whose blocks are all filtered out by the status legend sinks to the back. |
| **Auto-arrange engine** 自动排列 v11–v12 | Top-bar 自动排列 and the default layout: cards holding task blocks tile row-first (fill a row before wrapping) and their height auto-fits so the busy wall stays on one screen; collapsed empty cards gather into one compact shelf directly beneath, packed side-by-side at their own content width (row-first, no stretched gaps). |
| **Groups** 分组 | Drop a card onto another to form a group; members are tiled inside. Double-click the group title to rename in place. v12: groups NEST — drop a group's title bar onto another group (up to 4 levels, cycle-guarded; the store is always a legal forest); drag a nested group out of the body to extract it back to the wall; ✕ dissolves only the clicked level (children survive as top-level); empty group titles flow as compact strips inside the body, one per member group, draggable again. |
| **Content-aware layout** 按内容排布 | Members that hold task blocks get a bigger share of the group body, empty ones shrink. |
| **自动排列 per card** | A button on every card: put its task blocks back on the lattice, resize the card to its content, and (for a group) re-run the weighted layout. |
| **Dependency-aware packing** 依赖优先排布 | Inside a card, 自动排列 groups the tasks by their dependency chain: every CONNECTED chain gets its own contiguous run (a parent sits right above its child), so a wire never has to cross the blocks of an unrelated chain. |
| **Rubber-band select** 框选 | Drag on the empty canvas of a card to sweep a band over the task blocks: every block it touches is selected. Click a block to select it, shift-click to add. |
| **Group drag** 整体拖动 | Drag any selected block and the whole selection moves with it, rigidly (one write, one undo point). Click the empty canvas to drop the selection. |
| **Task detail popup** 任务详情 | Double-click any task block for status, assignee, model, timings, description, dependencies, recent runs, comments and events. |
| **Drag reference grid** 参考格子 | While you drag, an 8 px / 40 px grid appears so drops land tidy; toggle it off with 网格. |
| **Status filter** 状态筛选 | Global per-status chips hide whole statuses (persisted); every card also has a **筛选** dropdown for a multi-select, card-local filter. The two levels compose. |
| **Related-wire highlight** 关联高亮 v24 | Click a task block: every wire touching it lights up with a flowing dash and the related blocks highlight; unrelated wires dim. |
| **Task-block resize** 任务块缩放 v24 | Drag a block's corner grip to set its own width/height. The size persists per board; zooming or resizing the card leaves blocks at their set size. |
| **Hide groups** 分组隐藏 v24 | **隐藏** on a group header hides the whole group card; a restore chip appears in the top bar. |
| **Maximise** | Double-click a card's header to blow it up over the wall. |
| **Single-board view** 单板 | The full DAG for one board with pan / zoom / drag-to-place nodes. |

Everything lives in `localStorage`, nothing leaves your machine.
所有布局状态只写本机 `localStorage`，插件本身不联网。

---

## Install · 安装

**Requirements:** Hermes Agent with the dashboard (`hermes dashboard`). The
Python API uses `hermes_cli.kanban_db`, which ships with Hermes. Tested in
2026-10 against current Hermes builds (dashboard plugin SDK 1.1.0). Newer
builds gate tabs behind `plugins.enabled` — the `enable` step below is required
there and harmless on older builds.

### Default profile (recommended)

```bash
hermes plugins install weifengchui/hermes-kanban-graph
hermes plugins enable kanban-graph
hermes dashboard --stop && hermes dashboard --no-open --port 9119
```

Open <http://127.0.0.1:9119/kanban-graph>. On current builds the **Board+** tab
sits right after Kanban. The clone lands at
`~/.hermes/plugins/kanban-graph/` — the loader reads the payload from its
`dashboard/` subdirectory, which is exactly how this repo is laid out.

`hermes plugins update kanban-graph` upgrades a git install (see
[Upgrade](#upgrade--升级)); `hermes plugins remove kanban-graph` uninstalls. Both
leave your Kanban data and browser layout alone.

> **Why `enable`?** Newer Hermes builds list a dashboard tab only for plugins in
> `plugins.enabled` — an installed-but-not-enabled plugin is silently withheld
> from the tab bar, and its `api` is never imported. Older builds that only
> honour `dashboard.hidden_plugins` are unaffected; enabling is safe on both.

### Named profile or offline checkout

```bash
# from the repo root
./install.sh                 # default profile -> ~/.hermes/plugins/kanban-graph/dashboard/
./install.sh liteguard       # named profile -> ~/.hermes/profiles/liteguard/plugins/kanban-graph/dashboard/
HERMES_HOME=/x ./install.sh  # custom Hermes home

# then, for the profile you installed into (same HERMES_HOME if you set one)
hermes -p liteguard plugins enable kanban-graph
hermes -p liteguard dashboard --stop
hermes -p liteguard dashboard --no-open --port 9119
```

`install.sh` copies the four payload files from `dashboard/` into the target
profile, plus the root `plugin.yaml` (the CLI resolves the plugin *name* from
it — without it `hermes plugins enable kanban-graph` answers "No plugin named
'kanban-graph'"). If an older install already exists, it first backs it up to
`<profile dir>/plugin-backups/kanban-graph` (`~/.hermes/plugin-backups/kanban-graph`
for the default profile) so you can roll back.

**Full cross-machine playbook** (agent-facing skill, version-gated — enable
filter on newer builds, profile-shim workaround, isolated `HERMES_HOME`
launch, headless checks, why a fresh board is empty):
[`skills/board-plus-install/SKILL.md`](skills/board-plus-install/SKILL.md).

Manual install is the same five files, no build step: `manifest.json`,
`plugin_api.py`, `dist/index.js`, `dist/style.css` under
`<profile>/plugins/kanban-graph/dashboard/`, plus `plugin.yaml` at the plugin
root. The front-end is a plain script
(`window.__HERMES_PLUGINS__.register(...)`) — no bundler, no npm.

### Upgrade · 升级

Board+ keeps all layout (cards, groups, filters) in the browser's
`localStorage`, and tasks live in the Kanban SQLite files. Upgrading replaces
plugin files only — nothing to migrate, nothing lost.

**Installed with `hermes plugins install` (has `.git`):**

```bash
# named profile: prefix every command with -p <profile>
hermes plugins update kanban-graph
hermes plugins enable kanban-graph        # idempotent; run it again after upgrades
hermes dashboard --stop
hermes dashboard --no-open --port 9119
```

Then reload the page. Plugin assets are served `no-store`, so a normal reload
picks up the new JS/CSS; plugin **API** routes still need the dashboard restart.

**Installed with `install.sh` or a downloaded ZIP (no `.git`):**

`hermes plugins update` refuses these with `not installed from git` — expected.
Fetch the new version, then re-run the installer from the repo root:

```bash
git pull                     # or unpack the new ZIP
./install.sh                 # default profile
./install.sh <profile>       # named profile
```

The installer backs up the current plugin tree first (path printed), then
overwrites the payload. Enable + restart as above. Only one backup generation
is kept — copy it elsewhere if you want to retain older versions.

**Verify after any upgrade** (all four must pass):

```bash
curl -s http://127.0.0.1:9119/api/dashboard/plugins | grep -o kanban-graph
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/dashboard-plugins/kanban-graph/dist/index.js
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/dashboard-plugins/kanban-graph/dist/style.css
curl -s http://127.0.0.1:9119/openapi.json | grep -c '/api/plugins/kanban-graph/'
```

Expected: `kanban-graph`, `200`, `200`, and a count `≥ 1`. A visible tab without
the API route means the dashboard started before the plugin was enabled —
restart it.

**Roll back:** for a git install,
`git -C ~/.hermes/plugins/kanban-graph log --oneline` and
`git -C ~/.hermes/plugins/kanban-graph checkout <older-sha>`; for an
`install.sh` install, copy the backup back over
`<profile dir>/plugins/kanban-graph/`. Restart the dashboard afterwards.

### Repo layout · 仓库结构

```
hermes-kanban-graph/
├── plugin.yaml            # CLI-side manifest (name/version) — `plugins enable` resolves the name from it
├── dashboard/             # ← the plugin payload; only four files here are installed
│   ├── manifest.json      # tab config, icon, entry/css/api paths (relative to dashboard/)
│   ├── plugin_api.py      # FastAPI router → /api/plugins/kanban-graph/{status,boards,graph,task}
│   ├── dist/index.js      # pre-built front-end (IIFE), served as-is
│   ├── dist/style.css
│   ├── src/app.js         # readable source; `npm run build` copies it to dist/index.js
│   ├── src/StatusBar.jsx  # design source for the status bar
│   ├── mockups/           # static design mockup
│   └── package.json       # build script only, no dependencies
├── install.sh             # manual installer (backup + copy into a profile)
├── skills/board-plus-install/SKILL.md  # agent-facing install/upgrade playbook
├── tests/                 # Playwright acceptance probes (need a live dashboard)
├── tools/demo_shots.py    # regenerates screenshots/ against synthetic data
└── screenshots/
```

The `dashboard/` subdirectory is not cosmetic — the loader only discovers
`<plugin>/dashboard/manifest.json`, so a repo whose manifest sits at the root
clones successfully and then shows up nowhere. `src/`, `mockups/`, `tests/` and
`tools/` are development material and never land in a profile.

---

## Interactions · 操作

| gesture | effect |
|---|---|
| drag a card header | move it (magnet to neighbours + 8 px grid) |
| drag the bottom-right grip | resize (bottom-right only; origin stays put) |
| drop a card onto another | form a group |
| drag a member inside a group | move it inside the card |
| drag a group's title bar onto another group | NEST it (v12; cycle-proof — nesting into your own descendant is refused) |
| drag a nested group out of its parent's body | extract it back to the wall as a top-level group |
| click ✕ on a group | dissolve ONE level — member profiles free, child groups survive as top-level cards |
| double-click a card header | maximise / restore |
| double-click a task block | task detail popup (`Esc` or the backdrop closes it) |
| double-click a group title | rename in place (`Enter` saves, `Esc` cancels) |
| drag a task block inside a card | rearrange that profile's blocks |
| drag on the empty canvas of a card | rubber-band select every task block the band touches |
| click a task block | select it and light up its related wires (flowing dash) + blocks; shift-click adds / removes |
| drag a block's corner grip | resize that block alone; the size persists per board and is unaffected by card resize / zoom |
| drag a selected task block | move the WHOLE selection, rigidly |
| click the empty canvas of a card | drop the selection |
| click a status chip in the top bar | hide/show that status wall-wide (persisted) |
| open 筛选 on a card | multi-select which statuses that card draws (persisted, composes with the global chips) |
| click 隐藏 on a group header | hide the whole group card; restore it from the 已隐藏分组 chip in the top bar |
| click 自动排列 on a card | tidy that card (resize to its content / re-run the group layout / pack the dependency chains) |
| click 自动排列 in the toolbar | re-tile the whole wall, in card order (有任务块的在前，其后按名) |
| click 网格 | show/hide the drag reference grid |

---

## Screenshots

| | |
|---|---|
| ![groups](screenshots/02-groups.png) | grouped, weighted by content |
| ![drag grid](screenshots/03-drag-grid.png) | reference grid while dragging |
| ![task popup](screenshots/04-task-popup.png) | task detail popup |
| ![single](screenshots/05-single-board.png) | single-board DAG |

Regenerate them against **synthetic** data (no real board is read):

```bash
python tools/demo_shots.py        # needs the dashboard on :9119
```

---

## API

The plugin adds four read-only routes under
`/api/plugins/kanban-graph/` (registered by `plugin_api.py`). The board routes
open the SQLite file read-only (`file:…?mode=ro`).

| route | returns |
|---|---|
| `GET /status?profiles=a,b` | `{ok, home, profiles, running}` — which profiles have a live gateway/dashboard process (Linux `/proc` scan; `running` is empty elsewhere) |
| `GET /boards` | `{current, boards:[{slug,title,task_count,running}]}` |
| `GET /graph?board=<slug>&include_archived=1` | `{board, nodes, edges, back_edges}`; `edges` / `back_edges` are `[{parent,child}]`; nodes carry the task columns plus `tag` / `tagFull` / `tagColor`, the provider · model chip derived from that profile's config |
| `GET /task?board=<slug>&id=<task>` | `{board, task, parents, children, comments, events, runs}` — parent/child refs plus the same tag fields |

Without a `board` parameter, `/graph` and `/task` use the current board.
A missing board yields an empty graph (`404` for `/task`), and old board
schemas degrade to partial data instead of erroring.

---

## Layout knobs

Key constants in `dashboard/src/app.js` (the file `npm run build --prefix dashboard`
copies verbatim to `dist/index.js`):

```js
var GRID = 8, SNAP = 8, PMIN_W = 240, PMIN_H = 150, PDEF_W = 460, PDEF_H = 330,
    PGAP = 12, MINI_SCALE_MIN = 1.0, MINI_SCALE_MAX = 3.0;  // lattice / card sizes / zoom clamp
var GMIN_W = 320, GMIN_H = 230, GHEAD = 30, GBODY_PAD = 8, INNER_PAD = 6;  // group chrome
var IMIN_W = 180, IMIN_H = 108;               // an inner (grouped) card's minimums
var PROF_W_EMPTY = 1, PROF_W_BUSY = 3;        // content weight: empty … busy
```

`PROF_W_EMPTY`/`PROF_W_BUSY` drive the content-aware group layout
(`profWeight` → `weightedSlots`, a squarified treemap).

---

## Tests

`tests/` holds the Playwright acceptance probes used during development. They
drive a **live** dashboard (default `http://127.0.0.1:9119`; check each
docstring — some carry Linux-era paths), so they are a developer aid, not a CI
unit suite. Install Playwright + browsers first, start the dashboard, then run
e.g. `python tests/kg_v23_hl.py`.

Pure geometry is exposed on `window.__KG_TEST__` for DOM-free checks:

```js
window.__KG_TEST__.snapMove / snapResize / innerLayout / weightedSlots /
profWeight / squarifyRects / tileRects / groupByProfile / buildPanels …
```

---

## Troubleshooting · 排障

| symptom | cause | fix |
|---|---|---|
| no Board+ tab | plugin not enabled on a gated build, or the dashboard started before enabling | `hermes plugins enable kanban-graph` (add `-p <profile>`), then restart the dashboard |
| tab appears, page empty / API 404 | `plugin_api.py` was not imported at dashboard start | enable + restart; confirm `openapi.json` lists `/api/plugins/kanban-graph/` |
| `plugins enable` says "No plugin named 'kanban-graph'" | the profile's plugin dir lacks the root `plugin.yaml` | re-run `install.sh` (it copies `plugin.yaml`), or copy it into `<profile>/plugins/kanban-graph/` |
| `plugins update` says "not installed from git" | installed via `install.sh` / ZIP | re-run the new `install.sh`; it backs up the old install first |
| board is empty | Board+ only draws Hermes Kanban tasks — a fresh board has none | create one: `hermes -p <profile> kanban create "Title" --assignee <profile> [--parent t_xxxx]` |
| status dots never light up (Windows/macOS) | `/status` detects running profiles by scanning Linux `/proc` | expected outside Linux; task data is unaffected |
| assets 404 / plugins from the wrong profile | the dashboard was launched with a rewritten `HERMES_HOME` | follow the isolated-launch section in [`skills/board-plus-install/SKILL.md`](skills/board-plus-install/SKILL.md) |

Still stuck? Open an issue at
[weifengchui/hermes-kanban-graph](https://github.com/weifengchui/hermes-kanban-graph/issues)
with your Hermes version, OS, and the output of the four verification commands
above.

---

## License

MIT — see [LICENSE](LICENSE).
