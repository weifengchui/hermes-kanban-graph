---
name: board-plus-install
description: "跨机器安装 Board+ 看板插件：enable、绕 shim、隔离起服、验收、数据来源。"
version: 1.1.0
author: liteguard@B 初稿（2026-10-14 装机实测）；liteguard@A 发布前核验（版本门控与勘正）
license: MIT
platforms: [windows, linux]
metadata:
  hermes:
    tags: [hermes, dashboard, kanban, plugin, agentlink-fleet]
---

# Board+（kanban-graph）安装技能 — 任何机器通用

## 何时用
机主要求安装 Board+；或装了但 tab 不出现 / 看板空白。

Board+ = 看板插件：把 Hermes Kanban 任务画成方块、`父→子` 依赖画成连线，每个 assignee 一张卡片。仓库 `weifengchui/hermes-kanban-graph`（public）。本仓无 git tag，版本锚只认 main 的 commit sha——当前 = 270e39b2（v22.1）。

## 第0步 版本闸（必做，先于一切）
```
hermes --version
```
需要带 dashboard 插件发现函数的构建：
```
P=<能 import hermes_cli 的解释器>
$P -c "import hermes_cli.web_server as m; print(m.__file__)"
grep -c '_discover_dashboard_plugins' <该文件>
```
命中>0 ⇒ 继续。命中=0 ⇒ 升级 hermes 本体是全机共享操作、动所有 profile，**停下来请示机主**，勿自行升级。
（WSL 实测：系统 python3 import 不到 hermes_cli；用 `hermes --version` 报的 Install directory 里的 venv/tools 解释器，必要时加 `PYTHONPATH=<install目录>`。）

## 第1步 装到本 profile 私有目录（不碰公共目录）
```
export HOME=<家目录> HERMES_HOME=<家目录>/.hermes/profiles/<profile名>
hermes plugins install weifengchui/hermes-kanban-graph --no-enable
hermes plugins enable kanban-graph
```
- profile 名 = 本机 Hermes profile 目录名，全小写（`ls ~/.hermes/profiles/` 核实）。
- **enable 统一必做（按版本门控理解）**：新构建（2026-10-14 某机 v0.22.0 实测）`/api/dashboard/plugins` 按 `_plugin_activated(enabled_set)` 过滤——留着 `--no-enable` ⇒ discovery 命中也不出 tab；旧构建（v0.14.0 源码核验）该端点只按 `dashboard.hidden_plugins` 过滤，不 enable 也出 tab。enable 只写本 profile config、对旧版无副作用 ⇒ 一律照做最稳。
- clone 报 Connection reset ⇒ 重试 2-3 次；仍失败请已装好的机器走 agentlink `send-file` 直发四件（落点同下）。
- 校验四件（`$HERMES_HOME/plugins/kanban-graph/dashboard/` 下，sha256 前16 + 字节数须全等）：
```
manifest.json   349B   411ff61a245c0593
plugin_api.py   21911B 26e62e01bb0ef9c0
dist/index.js   203415B 66597a695f3b14db
dist/style.css  19540B 5b1f59f64f025e65
```
对不上先回发帖机核对是否已出新版本，别带病验收。

## 第2步 起隔离 dashboard
先查端口占用：`ss -ltn | grep -E ':91[0-9][0-9]\b'`（Windows 侧 `netstat -ano | findstr :91`），已占就换端口，别动别人进程。
**★profile shim 坑（部分机器才有）**：有的机器上 `hermes dashboard` 会被强制规范成 `-p default --open-profile <profile>` 的机器级托管，`export HERMES_HOME` 丢失 ⇒ profile-local 插件永远扫不到（日志特征：`[HERMES_HOME fallback]`）。没有被改写的机器直接 plain 起 + 显式 `HERMES_HOME` 即可，判定标准用第3步机检。绕法 = 直调 hermes 自带解释器 + 显式 env：

WSL/Linux：
```
TOOLS_PY=<本机 hermes 运行时解释器>   # 如 ~/.hermes/tools/python-3.*/bin/python3（目录名含日期，用 glob 取真名），
                                      # 或 `hermes --version` 报的 Install directory 内 venv 解释器
env HOME=$HOME HERMES_HOME=$HOME/.hermes/profiles/<profile> \
  $TOOLS_PY -m hermes_cli.main -p <profile> dashboard --isolated \
  --no-open --port 9129 --host 127.0.0.1
```
（★`--isolated` 是新构建参数（v0.22.0 实测有此参数）；旧构建（v0.14.0 实测）没有该参数，带着会报 unrecognized arguments——删掉它，改为确保启动环境里 HERMES_HOME 显式生效。另：venv/bin/python 可能是缺依赖的 uv python，跑不动就换 tools 解释器。）
Windows：同样思路——用 hermes 安装目录的 python `-m hermes_cli.main -p <profile> dashboard --isolated --no-open --port 9129 --host 127.0.0.1`，env 设 `HERMES_HOME=%USERPROFILE%\.hermes\profiles\<profile>`；`--isolated` 是否可带同上按版本定。
两个不要：不加 `--insecure`、host 不放 0.0.0.0。绑回环即可用（回环绑定本身免登录，不需要 --insecure）。

## 第3步 机检 + 浏览器验收
```
curl -s http://127.0.0.1:9129/api/dashboard/plugins        # 必须含 "kanban-graph"
curl -s -o /dev/null -w %{http_code} http://127.0.0.1:9129/dashboard-plugins/kanban-graph/dist/index.js   # 200
curl -s -o /dev/null -w %{http_code} http://127.0.0.1:9129/dashboard-plugins/kanban-graph/dist/style.css  # 200
```
浏览器开 `http://127.0.0.1:9129/kanban-graph`，左侧导航 BOARD+（导航统一大写渲染，正常）。tab 不出现：先确认第1步 enable 做了、本进程是 enable 之后新起的（插件清单是进程级缓存，改完必须重启 dashboard 进程）。`/api/dashboard/plugins/rescan` 要会话 token，裸 curl 回 Unauthorized 是正常，别误判服务挂。

## 看板为什么是空的 — 数据来源（重要，验收前告知机主）
- Board+ **只渲染 Hermes Kanban 板上的任务**（SQLite：机器级 `<hermes根>/kanban.db` 及 `kanban/boards/<slug>/kanban.db`，`hermes kanban` 命令族管理）。普通会话的 todo_list、cron 任务、聊天记录**不会自动上看板**——新机器装完板子空白是正常现象，不是装失败。
- kanban.db 按设计是**跨 profile 共享**的（原子认领、多 profile 协作），这与"插件文件放私有目录"不冲突。
- 放任务上去（CLI）：
```
hermes -p <profile> kanban create "标题" --assignee <profile> [--parent t_xxxx] [--body ...]
```
  或 dashboard 自带 Kanban tab（`/kanban`）里建卡。双击 Board+ 卡片上的方块看详情/依赖；单板视图有依赖连线。
- 演示/验收可建一对父子卡（`--parent` 出连线），完事 `kanban archive` 掉。

## 运维
- 该 dashboard 是手工进程：机器重启不自启。要常驻就加看门狗（cron/systemd 拉起 + 第3步机检）。
- 升级：`hermes plugins update kanban-graph`（进程级缓存 ⇒ 重启 dashboard）；升级后重核对四件 sha，并把新数字回帖同步进本技能实录/仓。
- 卸载：`hermes -p <profile> plugins remove kanban-graph`，只删本 profile 目录内文件。

## 排障速查
| 现象 | 原因 | 处理 |
|---|---|---|
| 装了没 tab | 未 enable（新构建） / 进程未重启 / shim 改写丢了 HERMES_HOME | 第1步 enable、重启进程、第2步按机器情况绕 shim |
| index.js 404 | 服务器 launch home ≠ 本 profile | 用第2步绕法；查 `[HERMES_HOME fallback]` 日志 |
| clone 失败 | 网络抖动 | 重试；或让已装机器 send-file 四件 |
| 看板空白 | 板上本来没任务 | `kanban create` 建卡，见数据来源节 |
| 端口被占 | 别的 profile 起了看板 | 换端口，别动别人进程 |

## 实录锚点
- 2026-10-14 v1.0：WSL 新构建（v0.22.0）装机实测 v22.1：四件全等；踩坑①shim 改写 ②--no-enable 被 enabled 过滤——固化为第1/2步。A 机原指导"--no-enable 不影响看板"在 v0.22.0 构建上不成立、在 v0.14.0 构建上成立 ⇒ 属版本差异，非谁写错。
- 2026-10-14 v1.1（发布版）：A 机源码核验后勘正——enable 过滤器与 `--isolated` 均标注为**新构建行为**（v0.14.0 源码端点只过滤 hidden_plugins、CLI 无 --isolated）；shim 标注为部分机器才有；LAN 机器编号脱敏。判定原则贯穿全篇：**凡"别人机器实测"的开关/参数，先按版本门控写，拿不准就用第3步机检定案**。
