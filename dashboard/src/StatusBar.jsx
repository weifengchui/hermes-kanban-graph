// Hermes 运行状态条（看板大屏左上角常驻）
// 口径（如实优先于好看）：
//   ● 绿 = 该 profile 的 gateway 进程在跑（ps 可见）——命令行不含 profile 名，按
//     gateway 启动约定：cwd=<home>/.hermes/profiles/<profile>（gateway start 即在该目录跑）；
//     HOME=/home/yxf 限定，防桌面版内嵌 gateway（HOME=/home/aen1102）的 cwd 假阳性。
//     ⚠️ 桌面版 Hermes 不跑独立 gateway 进程（AppImage 内嵌），故「桌面主对话」无绿点。
//   ● 灰 = 未检测到
//   本会话（当前 dashboard 会话所属 profile）额外标「·当前」蓝点。
// 数字为 kanban.db 跨板统计（全部任务/在办），只读。
// ⚠️ 2026-10-12 教训：本组件曾在被清理的开发工作区里写完但未入正本库而丢失；
//    任何未 commit 的交付物都不算存在，写完即入库。

const STATUS_PROFILE = {
  // dashboard 会话按 profile 隔离——liteguard 会话写死 liteguard；
  // 换其它 profile 会话时改这里或用 URL ?status_profile=x。
  current: new URLSearchParams(location.search).get('status_profile') || 'liteguard',
  rows: [
    { name: 'liteguard', label: '当前会话' },
    { name: 'default',   label: '桌面主对话' },
    { name: 'coding',    label: '代码' },
    { name: 'study',     label: '学科' },
  ],
};

function buildStatusBarCss() {
  return `
  .kg-status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 8px 0;
    padding: 7px 12px;
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(56, 189, 248, 0.18);
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.5;
    flex-wrap: wrap;
    min-width: max-content;
    width: 100%;
    box-sizing: border-box;
  }
  .kg-status-bar .kg-sb-title { color: #93c5fd; font-weight: 600; }
  .kg-status-bar .kg-sb-item {
    display: inline-flex; align-items: center; gap: 5px;
    color: #cbd5e1; padding: 1px 7px; border-radius: 5px;
    background: rgba(30, 41, 59, 0.5);
    border: 1px solid rgba(71, 85, 105, 0.35);
  }
  .kg-status-bar .kg-sb-dot { width: 8px; height: 8px; border-radius: 50%; background: #475569; flex-shrink: 0; }
  .kg-status-bar .kg-sb-dot.kg-sb-on { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7); }
  .kg-status-bar .kg-sb-cur { border-color: rgba(56, 189, 248, 0.5); background: rgba(14, 116, 144, 0.4); }
  .kg-status-bar .kg-sb-cur .kg-sb-name { color: #7dd3fc; }
  .kg-status-bar .kg-sb-cur .kg-sb-dot:not(.kg-sb-on) { background: #38bdf8; }
  .kg-status-bar .kg-sb-cur .kg-sb-tag { color: #38bdf8; font-size: 11px; margin-left: 2px; }
  .kg-status-bar .kg-sb-counts { color: #e2e8f0; margin-left: 4px; }
  .kg-status-bar .kg-sb-counts .kg-sb-num { color: #7dd3fc; font-weight: 600; }
  .kg-status-bar .kg-sb-hint { color: #64748b; font-size: 11px; margin-left: auto; }
`;
}

// 绿点判定：gateway 进程存在且 cwd=<home>/.hermes/profiles/<name>，且 HOME=<home>
async function probeRunning(name) {
  const cmd = `ps -eo args | grep '^python.*gateway run' >/dev/null; for d in /proc/[0-9]*/cwd; do l=$(readlink "$d" 2>/dev/null) && echo "$l"; done | grep -F -- ".hermes/profiles/${name}$" | head -1`;
  try {
    const r = await invokeShell(cmd, { timeoutSeconds: 8 });
    if (r.error) return false;
    const out = String((r.stdout || '')).trim();
    const h = String((r.home || '')).trim();
    return !!(h && out === `${h}/.hermes/profiles/${name}`);
  } catch { return false; }
}

function mountStatusBar(root) {
  let st = document.getElementById('kg-status-bar');
  if (!st) {
    st = document.createElement('div');
    st.id = 'kg-status-bar';
    st.className = 'kg-status-bar';
    st.addEventListener('click', () => {
      HermesAPI.toast('点左侧栏「对话」标签切换会话（dashboard 插件无直接切会话命令）', 'info');
    });
  } else st.textContent = '';
  if (!document.getElementById('kg-status-bar-css')) {
    const tag = document.createElement('style');
    tag.id = 'kg-status-bar-css';
    tag.textContent = buildStatusBarCss();
    document.head.appendChild(tag);
  }
  const span = (cls, text, extra) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    if (extra) extra(s);
    return s;
  };
  st.appendChild(span('kg-sb-title', 'Hermes 运行中'));
  const items = STATUS_PROFILE.rows.map(r => {
    const it = span('kg-sb-item', null, s => {
      const dot = span('kg-sb-dot'); s.appendChild(dot);
      s.appendChild(span('kg-sb-name', r.name));
      s.appendChild(span('kg-sb-label', ' · ' + r.label));
      if (r.name === STATUS_PROFILE.current) { s.classList.add('kg-sb-cur'); s.appendChild(span('kg-sb-tag', ' ▸当前')); }
    });
    it._dot = it.querySelector('.kg-sb-dot');
    st.appendChild(it);
    return { row: r, it };
  });
  const counts = span('kg-sb-counts', null);
  st.appendChild(counts);
  counts.textContent = '全部任务 – / 在办 –';
  st.appendChild(span('kg-sb-hint', '点我:切会话方式'));
  root.insertBefore(st, root.firstChild);
  const live = () => {
    Promise.all(items.map(x => probeRunning(x.row.name))).then(flags => {
      items.forEach((x, i) => x.it._dot.classList.toggle('kg-sb-on', !!flags[i]));
    });
    HermesAPI.fetchJson(`${HermesAPI.baseUrl()}/api/kanban/boards`)
      .then(d => {
        const bs = (d && d.boards) || [];
        const tot = bs.reduce((a, b) => a + (b.task_count || 0), 0);
        const run = bs.reduce((a, b) => a + (b.running || 0), 0);
        counts.textContent = `全部任务 ${tot} / 在办 ${run}`;
      }).catch(() => { counts.textContent = '任务数 –'; });
  };
  live();
  const t = setInterval(live, 30000);
  return () => clearInterval(t);
}
