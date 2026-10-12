from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query

from hermes_cli import kanban_db

try:  # profile configs are YAML; degrade to a regex reader if PyYAML is absent
    import yaml as _yaml
except Exception:  # pragma: no cover
    _yaml = None

# Status domain (documentation only; no validation performed server-side):
# triage, todo, scheduled, ready, running, blocked, review, done, archived

router = APIRouter()

NODE_COLUMNS = (
    "id",
    "title",
    "status",
    "assignee",
    "priority",
    "created_at",
    "started_at",
    "completed_at",
    "tenant",
)


DEFAULT_STATUS_PROFILES = ("liteguard", "default", "coding", "study")


@router.get("/status")
def agent_status(profiles: str = Query("")) -> dict:
    """Which Hermes profile services are running on this machine.

    Detection (read-only /proc scan, HOME-guarded): a profile counts when
    some process with HOME=<home> has argv `--profile <name>` AND either
    `gateway run` (the per-profile systemd fleet) or `dashboard` (the
    session host serving the big screen). argv matching, not cwd: this
    machine's gateways all run with cwd=hermes-agent.
    """
    home = os.path.expanduser("~")
    wanted = [p for p in re.split(r"[,\s]+", profiles.strip()) if p] or list(DEFAULT_STATUS_PROFILES)
    want_set = set(wanted)
    running: set[str] = set()
    try:
        pids = [d for d in os.listdir("/proc") if d.isdigit()]
    except OSError:
        pids = []
    for pid in pids:
        try:
            argv = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        text = [a.decode("utf-8", "replace") for a in argv if a]
        if not any(("gateway" in t and "run" in t) or "dashboard" in t for t in text):
            continue
        try:
            env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
        except OSError:
            continue
        if b"HOME=" + home.encode() not in env:
            continue
        hit = False
        prefix = f"HERMES_HOME={home}/.hermes/profiles/".encode()
        for kv in env:
            if kv.startswith(prefix):
                name = kv[len(prefix):].decode("utf-8", "replace")
                if name in want_set and any("gateway" in t or "dashboard" in t for t in text):
                    running.add(name)
                    hit = True
        if hit:
            continue
        for i, a in enumerate(text):
            if a == "--profile" and i + 1 < len(text) and text[i + 1] in want_set:
                running.add(text[i + 1])
    return {"ok": True, "home": home, "profiles": wanted, "running": sorted(running)}


@router.get("/boards")
def list_boards() -> dict:
    """Return the active board plus all non-archived boards."""
    current = kanban_db.get_current_board()
    boards = []
    for m in kanban_db.list_boards() or []:
        if m.get("archived"):
            continue
        slug = m.get("slug")
        if not slug:
            continue
        boards.append({"slug": slug, "title": m.get("title") or m.get("name") or slug})
    return {"current": current, "boards": boards}


def _break_cycles(edges: list[tuple[str, str]], node_ids: set[str]) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Kahn topological sort; on remaining cycles drop the lexicographically
    largest edge among the nodes participating in a cycle, until acyclic.
    Deterministic: candidate edges are sorted before each removal."""
    remaining = sorted(edges)
    back: list[tuple[str, str]] = []

    while True:
        # Kahn on `remaining`
        indeg = {n: 0 for n in node_ids}
        adj: dict[str, list[str]] = {n: [] for n in node_ids}
        for p, c in remaining:
            if p in indeg and c in indeg:
                adj[p].append(c)
                indeg[c] += 1
        queue = [n for n in node_ids if indeg[n] == 0]
        seen = 0
        while queue:
            n = queue.pop()
            seen += 1
            for c in adj[n]:
                indeg[c] -= 1
                if indeg[c] == 0:
                    queue.append(c)
        if seen == len(node_ids):
            return remaining, back

        # nodes still with indegree > 0 are in / downstream of a cycle
        stuck = {n for n in node_ids if indeg[n] > 0}
        # edges strictly inside the stuck subgraph (both endpoints stuck)
        candidates = sorted((p, c) for p, c in remaining if p in stuck and c in stuck)
        if not candidates:
            # shouldn't happen, but bail out to guarantee termination
            return remaining, back
        victim = candidates[-1]
        remaining = [e for e in remaining if e != victim]
        back.append(victim)


# ─────────────────── per-task API provider / model chip ───────────────────
# Every kanban worker runs under a Hermes profile; the profile's config.yaml
# carries the provider (base_url) and the default model. We resolve that per
# node and emit a compact chip: short code + colour + the full description.
# Resolution order: per-task override columns -> the assignee profile -> nothing
# (an unassigned task gets no chip rather than a misleading one).
_PROVIDERS = (
    # (needle in base_url/provider, label, short code, colour)
    ("deepseek", "DeepSeek", "DS", "#4d6bfe"),
    ("aliyuncs", "百炼", "百炼", "#ff6a00"),
    ("dashscope", "百炼", "百炼", "#ff6a00"),
    ("openrouter", "OpenRouter", "OR", "#8b5cf6"),
    ("anthropic", "Anthropic", "AN", "#d97757"),
    ("api.openai.com", "OpenAI", "OA", "#10a37f"),
    ("generativelanguage", "Google", "GE", "#4285f4"),
    ("googleapis", "Google", "GE", "#4285f4"),
    ("moonshot", "Kimi", "KM", "#6366f1"),
    ("bigmodel", "智谱", "GLM", "#2f6fed"),
    ("zhipu", "智谱", "GLM", "#2f6fed"),
    ("siliconflow", "硅基流动", "SF", "#14b8a6"),
    ("volces", "火山方舟", "DY", "#1664ff"),
    ("minimax", "MiniMax", "MM", "#e11d48"),
    ("x.ai", "xAI", "XA", "#6b7280"),
    ("groq", "Groq", "GQ", "#f55036"),
    ("localhost", "本地", "本地", "#10b981"),
    ("127.0.0.1", "本地", "本地", "#10b981"),
)
# trailing qualifier words abbreviated so the chip stays short ("v4-flash" -> "v4f")
_QUAL = {
    "flash": "f", "pro": "p", "mini": "m", "max": "x", "plus": "+", "turbo": "t",
    "air": "a", "lite": "l", "chat": "c", "instruct": "i", "thinking": "n",
    "preview": "pv", "coder": "c",
}

_CFG_CACHE: dict[str, tuple[float, dict]] = {}


def _hermes_home() -> Path:
    """The Hermes root home (the dir that holds profiles/ + config.yaml)."""
    env = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    cands: list[Path] = []
    try:
        p = kanban_db.kanban_db_path()
        if p:
            p = Path(p).resolve()  # <home>/kanban.db  or  <home>/kanban/boards/<slug>/kanban.db
            cands += [p.parent, p.parent.parent, p.parent.parent.parent]
    except Exception:
        pass
    cands.append(env)
    for c in cands:
        if (c / "profiles").is_dir():
            return c
    if env.parent.name == "profiles":  # HERMES_HOME was a profile home
        return env.parent.parent
    return env


def _model_block(path: Path) -> dict:
    """{'provider','default','base_url'} from a profile config (cached by mtime)."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    hit = _CFG_CACHE.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        txt = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    blk: dict = {}
    if _yaml is not None:
        try:
            data = _yaml.safe_load(txt) or {}
            raw = data.get("model") if isinstance(data, dict) else None
            if isinstance(raw, dict):
                for k in ("provider", "default", "model_name", "base_url"):
                    if raw.get(k):
                        blk["default" if k == "model_name" else k] = str(raw[k])
        except Exception:
            blk = {}
    if not blk:  # regex fallback (no PyYAML, or unparseable config)
        for k in ("provider", "default", "base_url"):
            m = re.search(r"^\s{2}%s:\s*(.+)$" % k, txt, re.M)
            if m:
                blk[k] = m.group(1).strip().strip("'\"")
    _CFG_CACHE[str(path)] = (mtime, blk)
    return blk


def _provider_of(provider: Optional[str], base_url: Optional[str], model: str) -> tuple[str, str, str, str]:
    hay = " ".join(x for x in (base_url or "", provider or "") if x).lower()
    pv = (provider or "").lower()
    for needle, label, short, color in _PROVIDERS:
        # match either way: a base_url containing the vendor host, or a provider
        # field naming the vendor ("openai" vs the "api.openai.com" needle)
        if needle in hay or (pv and pv in needle):
            return needle, label, short, color
    host = (urlparse(base_url or "").hostname or "").lower()
    if host:
        bits = [b for b in host.split(".") if b]
        label = bits[-2] if len(bits) >= 2 else host
        hue = sum(ord(c) for c in host) % 360
        return label, label, label[:3].upper(), "hsl(%d 62%% 58%%)" % hue
    if provider:
        return provider, provider, provider[:3].upper(), "#6b7280"
    return "", "", "", ""


def _short_model(name: str, prov_key: str) -> str:
    s = (name or "").strip()
    if not s:
        return ""
    toks = [t for t in re.split(r"[-_/ ]+", s) if t]
    if len(toks) > 1 and prov_key and toks[0].lower().startswith(prov_key[:4]):
        toks = toks[1:]  # "deepseek-v4-flash" under DeepSeek -> "v4-flash"
    if not toks:
        return s[:8]
    out = "".join(_QUAL.get(t.lower(), t) for t in toks)
    if len(out) <= 6:
        return out
    # too wide: keep the family initial(s) + the version + the qualifier initials
    # "qwen3.8-flash" -> "q3.8f"   "claude-sonnet-4.5" -> "cs4.5"   "gpt-5.3-codex" -> "g5.3c"
    ver, fam, qual = "", "", ""
    for t in toks:
        m = re.match(r"^([A-Za-z]*)(\d[\d.]*)(.*)$", t)
        if m and not ver:
            ver = (m.group(1)[:1].lower()) + m.group(2)
            if m.group(3):
                qual += _QUAL.get(m.group(3).lower(), m.group(3)[:1].lower())
            continue
        q = _QUAL.get(t.lower())
        if q:
            qual += q
        else:
            fam += t[:1]
    return ((fam[:2] + ver + qual) or out)[:8]


def _task_tag(
    assignee: Optional[str],
    provider_override: Optional[str],
    model_override: Optional[str],
    cache: dict,
) -> dict:
    """{'tag','tagFull','tagColor'} for one task (empty dict = no chip)."""
    provider = (provider_override or "").strip() or None
    model = (model_override or "").strip() or None
    base_url = None
    if provider is None or model is None:
        name = (assignee or "").strip()
        if not name:
            return {}
        if name not in cache:
            path = _hermes_home() / "profiles" / name / "config.yaml"
            blk = _model_block(path) if path.exists() else {}
            if not blk:
                cache[name] = None
            else:
                pv = blk.get("provider")
                key, label, short, color = _provider_of(pv, blk.get("base_url"), blk.get("default") or "")
                mdl = blk.get("default") or ""
                cache[name] = {
                    "prov": provider or pv, "model": model or mdl, "key": key,
                    "label": label, "short": short, "color": color,
                    "mshort": _short_model(model or mdl, key),
                }
        hit = cache[name]
        if not hit:
            return {}
        model = model or hit["model"]
        tag = (hit["short"] + (" " + hit["mshort"] if hit["mshort"] else "")).strip()
        full = hit["label"] + (" · " + model if model else "")
        return {"tag": tag, "tagFull": full, "tagColor": hit["color"]}
    # explicit per-task override wins
    key, label, short, color = _provider_of(provider, None, model)
    tag = (short + " " + _short_model(model, key)).strip()
    return {"tag": tag, "tagFull": label + " · " + model, "tagColor": color}


def _override_columns(conn: sqlite3.Connection) -> tuple[bool, bool]:
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    except sqlite3.Error:
        return (False, False)
    return ("provider_override" in cols, "model_override" in cols)


@router.get("/graph")
def graph(
    board: Optional[str] = Query(default=None),
    include_archived: bool = Query(default=False),
) -> dict:
    if board:
        try:
            normed = kanban_db._normalize_board_slug(board)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid board slug: {board!r}")
        if not normed:
            raise HTTPException(status_code=400, detail=f"invalid board slug: {board!r}")
    else:
        normed = kanban_db.get_current_board()

    path = kanban_db.kanban_db_path(board=normed)
    if not path or not path.exists():
        return {"board": normed, "nodes": [], "edges": [], "back_edges": []}

    nodes: list[dict] = []
    edges: list[tuple[str, str]] = []

    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        has_pv, has_md = _override_columns(conn)
        extra = (", provider_override" if has_pv else "") + (", model_override" if has_md else "")
        sql = f"SELECT {', '.join(NODE_COLUMNS)}{extra} FROM tasks"
        if not include_archived:
            sql += " WHERE status != 'archived'"
        try:
            for row in conn.execute(sql):
                d = {k: row[k] for k in NODE_COLUMNS}
                if has_pv:
                    d["provider_override"] = row["provider_override"]
                if has_md:
                    d["model_override"] = row["model_override"]
                nodes.append(d)
            for row in conn.execute("SELECT parent_id, child_id FROM task_links"):
                edges.append((row["parent_id"], row["child_id"]))
        except sqlite3.OperationalError:
            # DB exists but schema is missing (fresh/corrupt board) —
            # degrade to an empty graph instead of a 500.
            nodes, edges = [], []
    finally:
        conn.close()

    tcache: dict = {}
    for n in nodes:
        tag = _task_tag(n.get("assignee"), n.get("provider_override"), n.get("model_override"), tcache)
        n.pop("provider_override", None)
        n.pop("model_override", None)
        if tag:
            n["tag"], n["tagFull"], n["tagColor"] = tag["tag"], tag["tagFull"], tag["tagColor"]

    node_ids = {n["id"] for n in nodes}
    kept = [(p, c) for p, c in edges if p in node_ids and c in node_ids]
    kept, back = _break_cycles(kept, node_ids)

    ordered = sorted(node_ids)
    pos = {n: i for i, n in enumerate(ordered)}
    kept.sort(key=lambda e: (pos[e[0]], pos[e[1]]))

    return {
        "board": normed,
        "nodes": nodes,
        "edges": [{"parent": p, "child": c} for p, c in kept],
        "back_edges": [{"parent": p, "child": c} for p, c in back],
    }


# ─────────────────── one task in full (the double-click popup) ───────────────────
_DETAIL_COLS = (
    "id", "title", "status", "assignee", "priority", "created_by", "created_at",
    "started_at", "completed_at", "workspace_kind", "workspace_path", "branch_name",
    "tenant", "consecutive_failures", "skills", "session_id", "goal_mode",
    "block_kind", "last_heartbeat_at",
)
_DETAIL_TEXT = ("body", "result", "last_failure_error")
_DETAIL_MAX = 4000


def _resolve_board(board: Optional[str]) -> str:
    if board:
        try:
            normed = kanban_db._normalize_board_slug(board)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid board slug: {board!r}")
        if not normed:
            raise HTTPException(status_code=400, detail=f"invalid board slug: {board!r}")
        return normed
    return kanban_db.get_current_board()


@router.get("/task")
def task_detail(id: str = Query(...), board: Optional[str] = Query(default=None)) -> dict:
    """Everything the task-detail popup shows for one task id."""
    normed = _resolve_board(board)
    path = kanban_db.kanban_db_path(board=normed)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail=f"board not found: {normed}")

    parents: list[str] = []
    children: list[str] = []
    comments: list[dict] = []
    events: list[dict] = []
    runs: list[dict] = []
    refs: dict[str, dict] = {}
    task: dict = {}

    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
        if "id" not in cols:
            raise HTTPException(status_code=404, detail=f"no such task: {id}")
        want = [c for c in _DETAIL_COLS if c in cols] + [c for c in _DETAIL_TEXT if c in cols]
        row = conn.execute(
            "SELECT %s FROM tasks WHERE id = ?" % ", ".join(want), (id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"no such task: {id}")
        for k in want:
            v = row[k]
            if k in _DETAIL_TEXT and isinstance(v, str) and len(v) > _DETAIL_MAX:
                v = v[:_DETAIL_MAX] + "\n…（已截断）"
            task[k] = v

        links = [(r["parent_id"], r["child_id"]) for r in conn.execute("SELECT parent_id, child_id FROM task_links")]
        parents = [p for p, c in links if c == id]
        children = [c for p, c in links if p == id]
        need = sorted(set(parents) | set(children))
        if need:
            q = "SELECT id, title, status, assignee FROM tasks WHERE id IN (%s)" % ",".join("?" * len(need))
            for r in conn.execute(q, tuple(need)):
                refs[r["id"]] = {
                    "id": r["id"], "title": r["title"],
                    "status": r["status"], "assignee": r["assignee"],
                }

        for r in conn.execute(
            "SELECT author, body, created_at FROM task_comments WHERE task_id = ? "
            "ORDER BY created_at DESC LIMIT 8", (id,)
        ):
            comments.append({"author": r["author"], "body": (r["body"] or "")[:1200], "at": r["created_at"]})

        for r in conn.execute(
            "SELECT kind, payload, created_at FROM task_events WHERE task_id = ? "
            "ORDER BY created_at DESC LIMIT 8", (id,)
        ):
            events.append({"kind": r["kind"], "payload": (r["payload"] or "")[:400], "at": r["created_at"]})

        for r in conn.execute(
            "SELECT profile, status, outcome, summary, error, started_at, ended_at "
            "FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 5", (id,)
        ):
            runs.append({
                "profile": r["profile"], "status": r["status"], "outcome": r["outcome"],
                "summary": (r["summary"] or "")[:600], "error": (r["error"] or "")[:600],
                "started_at": r["started_at"], "ended_at": r["ended_at"],
            })
    except sqlite3.OperationalError:
        # old/fresh board schema: degrade to what we already have instead of a 500
        comments, events, runs = [], [], []
    finally:
        conn.close()

    out = {
        "board": normed,
        "task": task,
        "parents": [refs[x] for x in parents if x in refs],
        "children": [refs[x] for x in children if x in refs],
        "comments": comments,
        "events": events,
        "runs": runs,
    }
    out.update(_task_tag(task.get("assignee"), None, None, {}))
    return out
