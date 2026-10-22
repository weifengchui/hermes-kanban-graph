---
name: board-plus-install
description: "Install the Board+ dashboard plugin: version gate, install/enable, safe launch, headless checks, why a fresh board is empty. 跨机器通用安装技能（外部用户版）。"
version: 2.1.0
author: weifengchui
license: MIT
platforms: [windows, linux]
metadata:
  hermes:
    tags: [hermes, dashboard, kanban, plugin]
---

# Board+（kanban-graph）安装技能 — 通用

## 何时用
要在本机安装 Board+；或装了但 tab 不出现 / 看板空白。

Board+ = 看板插件：把 Hermes Kanban 任务画成方块、`父→子` 依赖画成连线，每个 assignee 一张卡片。仓库 `weifengchui/hermes-kanban-graph`（public）。本仓无 git tag，版本锚只认 main 的 commit sha。

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
命中>0 ⇒ 继续。命中=0 ⇒ 需要升级 hermes 本体——升级是全机共享操作、影响所有 profile，先与机主确认，勿自行执行。
（WSL/Linux 实测：系统 python3 通常 import 不到 hermes_cli；用 `hermes --version` 报的 Install directory 里的解释器，必要时加 `PYTHONPATH=<install目录>`。）

## 第1步 安装
**默认 profile：**
```
hermes plugins install weifengchui/hermes-kanban-graph
hermes plugins enable kanban-graph
```
**命名 profile（文件只进该 profile 私有目录，不碰公共目录）：**
```
export HOME=<家目录> HERMES_HOME=<家目录>/.hermes/profiles/<profile名>
hermes plugins install weifengchui/hermes-kanban-graph --no-enable
hermes plugins enable kanban-graph
```
- profile 名 = `~/.hermes/profiles/` 下的目录名，全小写。
- **enable 一律照做**：新构建的 `/api/dashboard/plugins` 按插件 enabled 集合过滤（不 enable 不出 tab）；旧构建只按 `dashboard.hidden_plugins` 过滤，enable 也无副作用。enable 只写本 profile 的 config，不影响其他 profile。
- **enable 报 "No plugin named 'kanban-graph'"**：说明该 profile 的插件目录里缺根级 `plugin.yaml`（CLI 靠它解析插件名；dashboard 只认 `dashboard/manifest.json`，所以 tab 能出、enable 却找不到）。修法：把仓库根的 `plugin.yaml` 复制到 `<profile>/plugins/kanban-graph/plugin.yaml`（新版 `install.sh` 已自带这一步），再执行 enable。
- **hermes 会按"粘性 active_profile"改写作用域**：`HERMES_HOME` 指向 hermes 根目录（非 `.../profiles/<名>`）时，CLI 会改用 `~/.hermes/active_profile` 指向的 profile。想操作默认 profile 必须显式 `hermes -p default …`；`HERMES_HOME=<root>/profiles/<名>` 才会被原样采用。
- clone 报 Connection reset（网络抖动）⇒ 重试 2-3 次；仍失败走离线路：GitHub 下载仓库 zip 解压，在仓库根执行 `./install.sh <profile名>`（等价落位到 `$HERMES_HOME/plugins/kanban-graph/dashboard/`；不带参数=默认 profile）。
- 完整性自检：安装件必须与你拿到的仓库 `dashboard/` 逐字节一致：
```
diff -r $HERMES_HOME/plugins/kanban-graph/dashboard <仓库解压路径>/dashboard
# 默认 profile 装在 ~/.hermes/plugins/kanban-graph/dashboard
```

## 第2步 起 dashboard（隔离、回环）
先查端口占用：`ss -ltn | grep -E ':91[0-9][0-9]\b'`（Windows 侧 `netstat -ano | findstr :91`），已占就换端口，别动别人进程。
```
env HOME=$HOME HERMES_HOME=$HOME/.hermes/profiles/<profile> \
  hermes -p <profile> dashboard --no-open --port 9129 --host 127.0.0.1
```
**两个不要**：不加 `--insecure`、host 不放 `0.0.0.0`。绑回环本身免登录，浏览器照常可用，不需要 `--insecure`。

部分机器的坑（没有被改写过的机器跳过，判定标准=第3步机检）：
- **CLI wrapper/shim**：个别环境 `hermes dashboard` 会被规范成机器级托管启动（如 `-p default --open-profile <profile>`），导出的 `HERMES_HOME` 丢失 ⇒ profile 私有插件扫不到（日志特征：`[HERMES_HOME fallback]`）。绕法 = 跳过 wrapper，直调安装目录里的解释器：`$TOOLS_PY -m hermes_cli.main -p <profile> dashboard …`（`TOOLS_PY` 取 Install directory 内 venv 的 python；目录名含版本号时用 glob 取真名）。个别新构建支持 `--isolated` 参数，旧构建没有（带着会报 unrecognized arguments，删掉即可）。
- uv 管理的 venv python 可能缺依赖跑不动 ⇒ 换安装目录自带解释器。
- Windows：同理用安装目录的 python 执行 `-m hermes_cli.main -p <profile> dashboard --no-open --port 9129 --host 127.0.0.1`，env 设 `HERMES_HOME=%USERPROFILE%\.hermes\profiles\<profile>`。

## 第3步 机检 + 浏览器验收
```
curl -s http://127.0.0.1:9129/api/dashboard/plugins        # 必须含 "kanban-graph"
curl -s -o /dev/null -w %{http_code} http://127.0.0.1:9129/dashboard-plugins/kanban-graph/dist/index.js   # 200
curl -s -o /dev/null -w %{http_code} http://127.0.0.1:9129/dashboard-plugins/kanban-graph/dist/style.css  # 200
curl -s http://127.0.0.1:9129/openapi.json | grep -c '/api/plugins/kanban-graph/'   # 必须 ≥1（后端已挂载）
```
最后一条最容易被漏：**tab 出现 ≠ 后端已挂载**。插件的 `api` 在进程启动时导入，启动那一刻若插件不在 `plugins.enabled`，路由根本不会注册——表现是页面能开但永远空/报错。enable 之后**必须重启 dashboard 进程**（本条 4 项全绿才算装好）。
浏览器开 `http://127.0.0.1:9129/kanban-graph`，左侧导航 BOARD+（导航对插件名统一大写渲染，属正常）。
tab 不出现：①确认第1步 enable 做了；②本进程必须是 enable 之后**新起**的（插件清单是进程级缓存，改完要重启 dashboard）。`/api/dashboard/plugins/rescan` 要会话 token，裸 curl 回 Unauthorized 是正常，别误判服务挂了。

## 看板为什么是空的 — 数据来源（验收前必读）
- Board+ **只渲染 Hermes Kanban 板上的任务**（SQLite：`<hermes根>/kanban.db` 及 `kanban/boards/<slug>/kanban.db`，`hermes kanban` 命令族管理）。普通会话的 todo_list、cron 任务、聊天记录**不会自动上看板**——新装完板子空白是正常现象，不是安装失败。
- kanban.db 按设计是跨 profile 共享的（原子认领、多 profile 协作），与"插件文件放私有目录"不冲突。
- 放任务上去（CLI）：
```
hermes -p <profile> kanban create "标题" --assignee <profile> [--parent t_xxxx] [--body ...]
```
  或在 dashboard 自带 Kanban tab（`/kanban`）里建卡。双击 Board+ 卡片上的方块看详情/依赖；单板视图有依赖连线。
- 演示/验收可建一对父子卡（`--parent` 出连线），完事 `kanban archive` 掉。

## 升级（旧版 → 新版）

先判断安装方式：插件目录里有 `.git` = CLI 安装，可 `plugins update`；没有 = install.sh / zip 安装，必须重装。

```
ls -d ~/.hermes/plugins/kanban-graph/.git 2>/dev/null        # 默认 profile
ls -d ~/.hermes/profiles/<profile>/plugins/kanban-graph/.git 2>/dev/null
```

**A. CLI / git 安装**（默认 profile 去掉 `-p <profile>`）：
```
git -C <插件目录> rev-parse --short HEAD     # 升级前记下旧 sha，便于回滚
hermes -p <profile> plugins update kanban-graph
hermes -p <profile> plugins enable kanban-graph      # 幂等；升级后建议重跑
hermes -p <profile> dashboard --stop
hermes -p <profile> dashboard --no-open --port 9129 --host 127.0.0.1
```

**B. install.sh / 离线 zip 安装**：
`hermes plugins update` 会报 `not installed from git`，属预期，不要反复试。取新版仓库（`git pull` 或解压新 zip），在仓库根重跑：
```
./install.sh <profile>
```
新版 install.sh 覆盖前会把旧安装整棵树备份到 `<profile目录>/plugin-backups/kanban-graph`（默认 profile 为 `~/.hermes/plugin-backups/kanban-graph`）并打印路径；只保留一份备份，要多版本请自行另存。随后同样 enable（第1步）+ 重启（第2步）。

**升级后必做**
1. 浏览器刷新页面：插件静态资源响应 `Cache-Control: no-store`，普通刷新即可；但后端 `api` 只在进程启动时导入，**必须重启 dashboard**。
2. 重跑第3步四项机检，全绿才算升级成功。
3. 布局/分组/筛选都在浏览器 localStorage，升级本身不迁移也不清空；换浏览器或清站点数据才会看起来“丢布局”。
4. 回滚：git 安装用记录下的旧 sha `git -C <插件目录> checkout <sha>`；install.sh 安装把备份树拷回 `<插件目录>/`。之后重启 dashboard。

## 运维
- 手工起的进程重启不自启：要常驻就自建 systemd/cron 拉起 + 第3步机检。
- 升级：见上一节。git 安装用 `plugins update`；install.sh/离线安装重装（自动备份），不要对无 `.git` 的目录反复 `plugins update`。
- **Hermes 升级后 tab 消失**：新构建的插件清单按 `plugins.enabled` 过滤，插件没进这个名单就静默不出 tab（同时它的 `api` 也不会被导入）。修：`hermes -p <profile> plugins enable kanban-graph` → 重启 dashboard 进程 → 跑第3步四项机检。
- 卸载：`hermes -p <profile> plugins remove kanban-graph`，只删该 profile 目录内文件。
- 问题反馈：GitHub issue → `weifengchui/hermes-kanban-graph`。

## 排障速查
| 现象 | 原因 | 处理 |
|---|---|---|
| 装了没 tab | 未 enable（新构建）/ 进程未重启 / wrapper 丢了 HERMES_HOME | 第1步 enable、重启进程、第2步绕法 |
| 升级后 tab 没了 | 新构建按 `plugins.enabled` 过滤；enable 条目不在名单里 | `hermes -p <profile> plugins enable kanban-graph` + 重启 dashboard |
| tab 在但页面空白/接口 404 | 插件 `api` 在启动那一刻未 enable，没被导入 | enable 后重启 dashboard；机检加 `openapi.json` 看 `/api/plugins/kanban-graph/` 路由 |
| enable 报 "No plugin named" | profile 插件目录缺根级 `plugin.yaml` | 复制仓库根 `plugin.yaml` 到 `<profile>/plugins/kanban-graph/`（新版 install.sh 自带） |
| `plugins update` 报 "not installed from git" | 该安装无 `.git`（install.sh / zip 装的） | 属预期；重跑新版 `install.sh`（自动备份），见升级节 B |
| 升级后仍是旧界面 | 标签页没刷新 / dashboard 进程没重启 | 刷新页面；API 变更必须重启进程（静态资源是 no-store） |
| index.js 404 | 服务启动时的 home ≠ 本 profile | 第2步绕法；查 `[HERMES_HOME fallback]` 日志 |
| clone 失败 | 网络抖动 | 重试；或 zip + `install.sh` 离线装 |
| 看板空白 | 板上本来没任务 | `kanban create` 建卡，见数据来源节 |
| 绿点一直不亮（Windows/macOS） | `/status` 靠扫 Linux `/proc` 判断运行中 profile | 非 Linux 属预期；任务展示不受影响 |
| 升级后布局"没了" | 换了浏览器/清了站点数据（布局只在 localStorage） | 升级本身不写 localStorage；回旧浏览器恢复站点数据 |
| 端口被占 | 别处已有看板 | 换端口，别动别人进程 |

## 兼容性备注
- 需要带 dashboard 插件发现功能的 Hermes 构建（第0步可判）。
- enable 过滤随构建版本不同：新构建按 enabled 集合过滤插件列表，旧构建只按 `dashboard.hidden_plugins`——统一 enable 对两种版本都安全。
- **enable 条目写在"服务该插件的那个 profile"的 config.yaml 里**：根目录安装的插件，每个 profile 的 dashboard 都能扫到，但每个 profile 都要各自 enable（`plugins.enabled` 是 per-profile 配置）。
- `--isolated` 仅个别新构建支持，旧构建为 unknown 参数。
- 2026-10 起在 Windows+WSL 与 Linux 环境实装验收通过。
