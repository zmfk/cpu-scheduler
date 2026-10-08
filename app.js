/* =========================================================
 * app.js —— UI 层（DOM 绑定、渲染、动画、导入导出）
 * 依赖：scheduler.js 暴露的 window.Scheduler
 *
 * ★ 本版改动：
 *   - 逐步时间轴按「每秒一格」渲染，不再合并连续段
 *   - 每格出现时闪一下（tl-flash，1s 一次性动画），之后静止
 *   - 播放速度改为秒级节奏（默认 1s / 秒），与闪烁同步
 *   - 时钟/就绪面板按「秒」反查所在段
 * ========================================================= */
(function () {
  'use strict';

  const S = window.Scheduler;

  const COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
    '#14b8a6', '#e11d48'
  ];

  const SEC_BLOCK_WIDTH = 34;   // 时间轴每秒的固定宽度（px）

  let rowSeq = 0;
  let colorMap = new Map();
  let currentResult = null;
  let currentSnapshots = null;
  let currentSeconds = null;    // 展开后的「逐秒」数组

  /* requestAnimationFrame 驱动的动画状态 */
  const anim = {
    revealed: 0,          // 已显示的秒数
    playing: false,
    rafId: null,
    lastTs: 0,
    speed: 1000,          // 毫秒 / 秒，默认 1s 一格
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------
   * 工具：把 compact timeline 展开成「逐秒」数组
   * 每段长度 span → span 个 { name, start, end } 格子
   * ------------------------------------------------------- */
  function expandToSeconds(timeline) {
    const seconds = [];
    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      for (let t = seg.start; t < seg.end; t++) {
        seconds.push({ name: seg.name, start: t, end: t + 1 });
      }
    }
    return seconds;
  }

  /* 根据「秒」反查所在的 compact 段索引（用于就绪队列快照） */
  function findSegmentIndexAtSecond(second) {
    if (!currentResult) return 0;
    let acc = 0;
    for (let i = 0; i < currentResult.timeline.length; i++) {
      const seg = currentResult.timeline[i];
      const span = seg.end - seg.start;
      if (second < acc + span) return i;
      acc += span;
    }
    return currentResult.timeline.length - 1;
  }

  /* ---------------------------------------------------------
   * Toast
   * ------------------------------------------------------- */
  function toast(msg, type) {
    type = type || 'error';
    const container = $('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span>' + (type === 'error' ? '⚠️' : '✅') + '</span><span>' + esc(msg) + '</span>';
    container.appendChild(el);
    setTimeout(function () {
      el.style.animation = 'toastOut .3s ease forwards';
      setTimeout(function () { el.remove(); }, 300);
    }, 2800);
  }

  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  /* ---------------------------------------------------------
   * 主题
   * ------------------------------------------------------- */
  (function initTheme() {
    const btn = $('themeBtn');
    const saved = localStorage.getItem('cpu-theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    btn.textContent = saved === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', function () {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('cpu-theme', next);
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
    });
  })();

  /* ---------------------------------------------------------
   * 进程行管理
   * ------------------------------------------------------- */
  function addRow(name, arrival, burst, priority) {
    name = name == null ? '' : name;
    arrival = arrival == null ? '' : arrival;
    burst = burst == null ? '' : burst;
    priority = priority == null ? '' : priority;

    const list = $('processList');
    const id = ++rowSeq;
    const color = COLORS[(id - 1) % COLORS.length];

    const item = document.createElement('div');
    item.className = 'process-chip';
    item.dataset.id = id;
    item.innerHTML =
      '<span class="chip-dot" style="background:' + color + ';"></span>' +
      '<input type="text" class="p-name"     value="' + esc(name)     + '" placeholder="进程名" title="进程名">' +
      '<input type="text" class="p-arrival"  value="' + esc(arrival)  + '" placeholder="到达"   title="到达时间" inputmode="numeric">' +
      '<input type="text" class="p-burst"    value="' + esc(burst)    + '" placeholder="执行"   title="运行时间" inputmode="numeric">' +
      '<input type="text" class="p-priority" value="' + esc(priority) + '" placeholder="优先"   title="优先级（数值越小优先级越高）" inputmode="numeric">' +
      '<button class="chip-del" title="删除">✕</button>';

    item.querySelector('.chip-del').addEventListener('click', function () {
      item.remove();
      updateCount();
    });

    list.appendChild(item);
    updateCount();
  }

  function updateCount() {
    $('procCount').textContent = $$('#processList .process-chip').length;
  }

  function clearAll() {
    $('processList').innerHTML = '';
    rowSeq = 0;
    updateCount();
    resetResultArea();
    stopAnim();
    currentResult = null;
    currentSnapshots = null;
    currentSeconds = null;
  }

  function resetResultArea() {
    $('resultArea').innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">📊</div>' +
        '<p>配置进程并选择算法后<br>点击「开始调度」逐步查看结果</p>' +
      '</div>';
    $('resultMeta').style.display = 'none';
  }

  /* ---------------------------------------------------------
   * 读取 / 校验进程输入
   * ------------------------------------------------------- */
  function readProcesses() {
    const items = Array.prototype.slice.call($$('#processList .process-chip'));
    const list = [];
    const names = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const name = item.querySelector('.p-name').value.trim();
      const aRaw = item.querySelector('.p-arrival').value.trim();
      const bRaw = item.querySelector('.p-burst').value.trim();
      const pRaw = item.querySelector('.p-priority').value.trim();

      if (!name && !aRaw && !bRaw && !pRaw) continue;
      if (!name) return { error: '存在未填写的进程名' };
      if (names.has(name)) return { error: '进程名「' + name + '」重复' };
      names.add(name);

      if (!/^\d+$/.test(aRaw)) return { error: '「' + name + '」到达时间无效（需为非负整数）' };
      if (!/^\d+$/.test(bRaw) || Number(bRaw) <= 0) {
        return { error: '「' + name + '」运行时间无效（需为正整数）' };
      }
      let prio = 0;
      if (pRaw !== '') {
        if (!/^\d+$/.test(pRaw)) return { error: '「' + name + '」优先级无效（需为非负整数）' };
        prio = Number(pRaw);
      }

      list.push({
        name: name,
        arrival: Number(aRaw),
        burst: Number(bRaw),
        priority: prio,
      });
    }

    if (!list.length) return { error: '请至少输入一个进程' };
    return { list: list };
  }

  /* ---------------------------------------------------------
   * 算法选择 UI
   * ------------------------------------------------------- */
  function initAlgoPills() {
    const wrap = $('algoPills');
    const keys = Object.keys(S.ALGORITHMS);
    wrap.innerHTML = keys.map(function (key, i) {
      const a = S.ALGORITHMS[key];
      return '<label class="algo-pill' + (i === 0 ? ' active' : '') + '">' +
               '<input type="radio" name="algo" value="' + key + '"' + (i === 0 ? ' checked' : '') + '>' +
               '<span class="pill-dot"></span>' + esc(a.name) + ' ' + a.badge +
             '</label>';
    }).join('');

    Array.prototype.forEach.call(wrap.querySelectorAll('.algo-pill'), function (pill) {
      pill.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.querySelectorAll('.algo-pill'), function (p) {
          p.classList.remove('active');
        });
        pill.classList.add('active');
        pill.querySelector('input').checked = true;
        syncQuantumField();
      });
    });
  }

  function initCompareSelects() {
    const opts = Object.keys(S.ALGORITHMS).map(function (key) {
      const a = S.ALGORITHMS[key];
      return '<option value="' + key + '">' + a.badge + ' · ' + esc(a.name) + '</option>';
    }).join('');

    const a = $('compareA'), b = $('compareB');
    a.innerHTML = opts;
    b.innerHTML = opts;
    a.value = 'fcfs';
    b.value = 'sjf';
  }

  function currentAlgo() {
    const el = document.querySelector('input[name="algo"]:checked');
    return el ? el.value : 'fcfs';
  }

  function syncQuantumField() {
    const algo = currentAlgo();
    const meta = S.ALGORITHMS[algo];
    const field = $('quantumField');
    const input = $('quantum');
    const label = field.querySelector('label');

    if (!meta.needQuantum) {
      field.style.display = 'none';
      return;
    }
    field.style.display = 'inline-flex';

    if (algo === 'mlfq') {
      label.childNodes[0].nodeValue = '各级时间片 ';
      input.type = 'text';
      input.style.width = '92px';
      if (!/,/.test(input.value)) input.value = S.DEFAULT_QUANTA.join(',');
    } else {
      label.childNodes[0].nodeValue = '时间片 ';
      input.type = 'number';
      input.style.width = '60px';
      input.min = '1';
      if (/,/.test(input.value)) input.value = '2';
    }
  }

  function getOptions() {
    const algo = currentAlgo();
    const opts = {};

    if (algo === 'rr') {
      const q = parseInt($('quantum').value, 10);
      opts.quantum = (isFinite(q) && q >= 1) ? q : 2;
    } else if (algo === 'mlfq') {
      const parts = $('quantum').value.split(',')
        .map(function (s) { return parseInt(s.trim(), 10); })
        .filter(function (n) { return isFinite(n) && n >= 1; });
      opts.mlfqQuanta = parts.length ? parts : S.DEFAULT_QUANTA;
    }
    return opts;
  }

  /* ---------------------------------------------------------
   * 渲染：指标卡 / 表格 / 顺序
   * ------------------------------------------------------- */
  function renderMetricCards(stats) {
    return '' +
      '<div class="metric-card"><div class="metric-label">平均周转</div>' +
        '<div class="metric-value accent">' + stats.avgTurnaround.toFixed(2) +
        '<span class="metric-unit">t</span></div></div>' +
      '<div class="metric-card"><div class="metric-label">平均等待</div>' +
        '<div class="metric-value warning">' + stats.avgWaiting.toFixed(2) +
        '<span class="metric-unit">t</span></div></div>' +
      '<div class="metric-card"><div class="metric-label">平均响应</div>' +
        '<div class="metric-value purple">' + stats.avgResponse.toFixed(2) +
        '<span class="metric-unit">t</span></div></div>' +
      '<div class="metric-card"><div class="metric-label">CPU 利用率</div>' +
        '<div class="metric-value success">' + stats.utilization.toFixed(1) +
        '<span class="metric-unit">%</span></div></div>' +
      '<div class="metric-card"><div class="metric-label">完成时长</div>' +
        '<div class="metric-value">' + stats.totalTime +
        '<span class="metric-unit">t</span></div></div>';
  }

  function renderTable(processes, withPriority) {
    let html = '<table class="result-table"><thead><tr>' +
      '<th>进程</th><th>到达</th><th>执行</th>' +
      (withPriority ? '<th>优先级</th>' : '') +
      '<th>开始</th><th>完成</th><th>周转</th><th>等待</th></tr></thead><tbody>';

    processes.forEach(function (p) {
      const color = colorMap.get(p.name) || '#888';
      html += '<tr>' +
        '<td><span class="p-dot" style="background:' + color + '"></span>' + esc(p.name) + '</td>' +
        '<td>' + p.arrival + '</td>' +
        '<td>' + p.burst + '</td>' +
        (withPriority ? '<td>' + p.priority + '</td>' : '') +
        '<td>' + p.start + '</td>' +
        '<td>' + p.finish + '</td>' +
        '<td>' + p.turnaround + '</td>' +
        '<td>' + p.waiting + '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function renderOrder(timeline) {
    const nodes = timeline.map(function (seg, i) {
      const arrow = i > 0 ? '<span class="order-arrow">→</span>' : '';
      if (seg.name === null) {
        return arrow + '<span class="order-node idle-node">空闲</span>';
      }
      const color = colorMap.get(seg.name) || '#888';
      return arrow + '<span class="order-node" style="background:' + color + '">' + esc(seg.name) + '</span>';
    }).join('');
    return '<div class="order-flow"><span class="order-label">调度顺序</span>' + nodes + '</div>';
  }

  /* ---------------------------------------------------------
   * 渲染：单算法视图骨架
   * ------------------------------------------------------- */
  function renderSingleAlgoView(result) {
    const meta = S.ALGORITHMS[result.algorithm];
    const needPrio = meta.needPriority;

    let quantumInfo = '';
    if (result.quantum != null) {
      quantumInfo = Array.isArray(result.quantum)
        ? ' · 时间片 [' + result.quantum.join(', ') + ']'
        : ' · 时间片 ' + result.quantum;
    }

    return '' +
      '<div class="result-block">' +
        '<div class="block-title">' + esc(meta.name) +
          ' <span class="badge">' + meta.badge + '</span>' +
          '<span style="font-size:12px;color:var(--text-muted);font-weight:500">' +
            (meta.preemptive ? '抢占式' : '非抢占式') + quantumInfo +
          '</span>' +
        '</div>' +

        '<div class="play-controls">' +
          '<button class="btn btn-primary play-btn">▶ 播放</button>' +
          '<button class="btn btn-ghost reset-btn">↻ 重置</button>' +
          '<label class="speed-label">速度' +
            '<select class="speed-select">' +
              '<option value="2000">慢速（2s/秒）</option>' +
              '<option value="1000" selected>正常（1s/秒）</option>' +
              '<option value="500">快速（0.5s/秒）</option>' +
            '</select>' +
          '</label>' +
          '<span style="font-size:12px;color:var(--text-muted)">共 ' +
            result.stats.totalTime + ' 个时间单位（逐秒）</span>' +
        '</div>' +

        '<div class="ready-panel">' +
          '<div class="ready-clock-box">' +
            '<div class="ready-clock-label">时钟</div>' +
            '<div class="ready-clock-value">0</div>' +
            '<div class="ready-clock-total">/ ' + result.stats.totalTime + ' t</div>' +
          '</div>' +
          '<div class="ready-main">' +
            '<div class="ready-row"><span class="ready-label">▶ 运行中</span>' +
              '<div class="ready-chips running-chips">' +
                '<span class="ready-empty">等待开始…</span></div></div>' +
            '<div class="ready-row"><span class="ready-label">⏳ 就绪队列</span>' +
              '<div class="ready-chips queue-chips">' +
                '<span class="ready-empty">—</span></div></div>' +
          '</div>' +
        '</div>' +

        '<div class="gantt-section">' +
          '<div class="gantt-label">⏱ 逐步时间轴（每秒一格）</div>' +
          '<div class="tl-wrap"><div class="tl-track"><div class="tl-empty">等待开始…</div></div></div>' +
        '</div>' +

        '<div class="gantt-section">' +
          '<div class="gantt-label">📊 甘特图</div>' +
          '<div class="gantt-wrap">' +
            '<div class="gantt"></div>' +
            '<div class="gantt-times"></div>' +
          '</div>' +
        '</div>' +

        '<div class="metrics-row">' + renderMetricCards(result.stats) + '</div>' +
        '<div class="table-wrap">' + renderTable(result.processes, needPrio) + '</div>' +
        renderOrder(result.timeline) +
      '</div>';
  }

  /* ---------------------------------------------------------
   * 逐步时间轴：每秒一格 + 每格入场闪一下
   * ------------------------------------------------------- */
  function makeTimelineBlock(sec) {
    const el = document.createElement('div');
    el.style.flex = '0 0 ' + SEC_BLOCK_WIDTH + 'px';

    if (sec.name === null) {
      el.className = 'tl-block tl-idle tl-flash';
      el.title = '空闲 t=' + sec.start;
      el.innerHTML =
        '<span class="tl-name">空闲</span>' +
        '<span class="tl-time">' + sec.start + '</span>';
    } else {
      el.className = 'tl-block tl-flash';
      el.style.background = colorMap.get(sec.name) || '#888';
      el.title = sec.name + '：t=' + sec.start + ' → ' + sec.end;
      el.innerHTML =
        '<span class="tl-name">' + esc(sec.name) + '</span>' +
        '<span class="tl-time">' + sec.start + '</span>';
    }
    return el;
  }

  function renderTimelineIncremental() {
    const block = document.querySelector('.result-block');
    if (!block || !currentResult || !currentSeconds) return;
    const track = block.querySelector('.tl-track');
    const wrap = block.querySelector('.tl-wrap');
    const total = currentSeconds.length;
    const target = Math.min(anim.revealed, total);

    if (target === 0) {
      track.innerHTML = '<div class="tl-empty">等待开始…</div>';
      return;
    }
    const ph = track.querySelector('.tl-empty');
    if (ph) ph.remove();

    const shown = track.children.length;
    if (shown > target) {
      while (track.children.length > target) track.removeChild(track.lastElementChild);
    } else {
      for (let i = shown; i < target; i++) {
        // 每新增一格，会自然触发一次 tl-flash 动画（秒闪）
        track.appendChild(makeTimelineBlock(currentSeconds[i]));
      }
    }

    if (wrap) {
      requestAnimationFrame(function () { wrap.scrollLeft = wrap.scrollWidth; });
    }
  }

  /* ---------------------------------------------------------
   * 甘特图（保持合块的 compact timeline）
   * ------------------------------------------------------- */
  function ganttBlockHTML(seg, pct) {
    const tip = '<span class="tip">' +
      (seg.name === null ? '空闲' : esc(seg.name)) + '：' + seg.start + ' → ' + seg.end +
      '</span>';
    const label = seg.name === null
      ? (pct > 8 ? '空闲' : '')
      : (pct > 4 ? esc(seg.name) : '');
    return tip + label;
  }

  function renderGantt() {
    const block = document.querySelector('.result-block');
    if (!block || !currentResult) return;
    const el = block.querySelector('.gantt');
    const timesEl = block.querySelector('.gantt-times');
    const total = currentResult.stats.totalTime || 1;
    const revealed = anim.revealed;

    if (revealed === 0) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;' +
        'width:100%;color:var(--text-muted);font-size:12px;font-style:italic;">等待开始…</div>';
      timesEl.innerHTML = '';
      return;
    }

    // 根据已揭示秒数，裁剪出对应的 compact 段
    const segs = [];
    let acc = 0;
    for (let i = 0; i < currentResult.timeline.length; i++) {
      const seg = currentResult.timeline[i];
      const span = seg.end - seg.start;
      if (acc + span <= revealed) {
        segs.push(seg);
        acc += span;
      } else {
        // 当前段被部分揭示
        const shownSpan = revealed - acc;
        if (shownSpan > 0) {
          segs.push({ name: seg.name, start: seg.start, end: seg.start + shownSpan });
        }
        break;
      }
    }

    let html = '';
    let accPct = 0;
    let timesHtml = '';
    segs.forEach(function (seg) {
      const pct = ((seg.end - seg.start) / total) * 100;
      if (seg.name === null) {
        html += '<div class="gantt-block gantt-idle" style="flex:0 0 ' + pct + '%">' +
          ganttBlockHTML(seg, pct) + '</div>';
      } else {
        const color = colorMap.get(seg.name) || '#888';
        html += '<div class="gantt-block" style="flex:0 0 ' + pct + '%;background:' + color + '">' +
          ganttBlockHTML(seg, pct) + '</div>';
      }
      timesHtml += '<span style="left:' + accPct + '%">' + seg.start + '</span>';
      accPct += pct;
    });
    timesHtml += '<span style="left:100%">' + total + '</span>';

    el.innerHTML = html;
    timesEl.innerHTML = timesHtml;
  }

  /* ---------------------------------------------------------
   * 就绪队列面板（按「秒」定位所在段）
   * ------------------------------------------------------- */
  function renderReadyPanel() {
    const block = document.querySelector('.result-block');
    if (!block || !currentResult) return;

    const clockEl = block.querySelector('.ready-clock-value');
    const runningEl = block.querySelector('.running-chips');
    const queueEl = block.querySelector('.queue-chips');
    const total = currentSeconds ? currentSeconds.length : 0;

    if (anim.revealed === 0) {
      clockEl.textContent = '0';
      runningEl.innerHTML = '<span class="ready-empty">等待开始…</span>';
      queueEl.innerHTML = '<span class="ready-empty">—</span>';
      return;
    }

    // 时钟：已揭示的秒数即当前时刻
    clockEl.textContent = String(anim.revealed);

    if (anim.revealed >= total) {
      runningEl.innerHTML = '<span class="ready-empty done">✓ 全部完成</span>';
      queueEl.innerHTML = '<span class="ready-empty">—</span>';
      return;
    }

    // 用「秒」反查所在 compact 段的快照
    const second = anim.revealed - 1;             // 0-based
    const segIdx = findSegmentIndexAtSecond(second);
    const snap = currentSnapshots[segIdx];
    if (!snap) return;

    if (snap.running === null) {
      runningEl.innerHTML = '<span class="ready-empty">CPU 空闲</span>';
    } else {
      const color = colorMap.get(snap.running) || '#888';
      runningEl.innerHTML =
        '<span class="ready-chip running" style="--chip-color:' + color + '">' +
          '<span class="chip-dot-mini"></span>' +
          '<span>' + esc(snap.running) + '</span>' +
          '<span class="chip-remaining">剩 ' + snap.runningRemaining + 't</span>' +
        '</span>';
    }

    if (!snap.ready.length) {
      queueEl.innerHTML = '<span class="ready-empty">（空）</span>';
    } else {
      queueEl.innerHTML = snap.ready.map(function (r) {
        const color = colorMap.get(r.name) || '#888';
        return '<span class="ready-chip" style="--chip-color:' + color + '">' +
                 '<span class="chip-dot-mini"></span>' +
                 '<span>' + esc(r.name) + '</span>' +
                 '<span class="chip-remaining">剩 ' + r.remaining + 't</span>' +
               '</span>';
      }).join('');
    }
  }

  /* ---------------------------------------------------------
   * 动画（requestAnimationFrame 驱动）
   * ------------------------------------------------------- */
  function updatePlaybackUI() {
    if (!currentResult || !currentSeconds) return;
    renderReadyPanel();
    renderTimelineIncremental();
    renderGantt();

    const playBtn = document.querySelector('.play-btn');
    if (playBtn) {
      const finished = anim.revealed >= currentSeconds.length;
      if (finished) playBtn.textContent = '↻ 重播';
      else if (anim.playing) playBtn.textContent = '⏸ 暂停';
      else playBtn.textContent = '▶ 播放';
    }
  }

  function tick(ts) {
    if (!anim.playing) return;
    if (!anim.lastTs) anim.lastTs = ts;

    const total = currentSeconds.length;
    if (ts - anim.lastTs >= anim.speed) {
      anim.lastTs = ts;
      anim.revealed++;
      if (anim.revealed >= total) {
        anim.revealed = total;
        stopAnim();
      }
      updatePlaybackUI();
    }
    anim.rafId = requestAnimationFrame(tick);
  }

  function startAnim() {
    stopAnim();
    if (!currentResult || !currentSeconds) return;
    anim.revealed = 0;
    anim.playing = true;
    anim.lastTs = 0;
    updatePlaybackUI();
    anim.rafId = requestAnimationFrame(tick);
  }

  function resumeAnim() {
    if (!currentResult || !currentSeconds) return;
    if (anim.revealed >= currentSeconds.length) anim.revealed = 0;
    anim.playing = true;
    anim.lastTs = 0;
    anim.rafId = requestAnimationFrame(tick);
    updatePlaybackUI();
  }

  function stopAnim() {
    if (anim.rafId) cancelAnimationFrame(anim.rafId);
    anim.rafId = null;
    anim.playing = false;
  }

  function bindPlayControls() {
    const playBtn = document.querySelector('.play-btn');
    const resetBtn = document.querySelector('.reset-btn');
    const speedSel = document.querySelector('.speed-select');

    if (playBtn) {
      playBtn.addEventListener('click', function () {
        const finished = anim.revealed >= currentSeconds.length;
        if (finished) {
          startAnim();
        } else if (anim.playing) {
          stopAnim();
          updatePlaybackUI();
        } else {
          resumeAnim();
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        stopAnim();
        anim.revealed = 0;
        updatePlaybackUI();
      });
    }

    if (speedSel) {
      speedSel.addEventListener('change', function () {
        anim.speed = parseInt(this.value, 10) || 1000;
      });
    }
  }

  /* ---------------------------------------------------------
   * 主流程：单算法调度
   * ------------------------------------------------------- */
  function run() {
    const res = readProcesses();
    if (res.error) { toast(res.error); return; }

    const algo = currentAlgo();
    const opts = getOptions();

    colorMap = new Map();
    res.list.forEach(function (p, i) {
      colorMap.set(p.name, COLORS[i % COLORS.length]);
    });

    let result;
    try {
      result = S.run(res.list, algo, opts);
    } catch (e) {
      toast(e.message);
      return;
    }

    currentResult = result;
    currentSnapshots = S.buildSnapshots(result);
    currentSeconds = expandToSeconds(result.timeline);   // ★ 逐秒展开

    $('resultArea').innerHTML = renderSingleAlgoView(result);
    const meta = $('resultMeta');
    meta.textContent = result.processes.length + ' 个进程 · ' +
      result.stats.totalTime + ' 秒（' + result.timeline.length + ' 段）';
    meta.style.display = 'inline-flex';

    bindPlayControls();
    toast('调度完成', 'success');
    startAnim();
  }

  /* ---------------------------------------------------------
   * 算法对比（用合块甘特图，不做逐秒动画）
   * ------------------------------------------------------- */
  function renderCompareColumn(algoKey, result) {
    const meta = S.ALGORITHMS[algoKey];
    const total = result.stats.totalTime || 1;

    let gantt = '';
    result.timeline.forEach(function (seg) {
      const pct = ((seg.end - seg.start) / total) * 100;
      if (seg.name === null) {
        gantt += '<div class="gantt-block gantt-idle" style="flex:0 0 ' + pct + '%">' +
          ganttBlockHTML(seg, pct) + '</div>';
      } else {
        const color = colorMap.get(seg.name) || '#888';
        gantt += '<div class="gantt-block" style="flex:0 0 ' + pct + '%;background:' + color + '">' +
          ganttBlockHTML(seg, pct) + '</div>';
      }
    });

    let times = '';
    let acc = 0;
    result.timeline.forEach(function (seg) {
      times += '<span style="left:' + acc + '%">' + seg.start + '</span>';
      acc += ((seg.end - seg.start) / total) * 100;
    });
    times += '<span style="left:100%">' + total + '</span>';

    return '' +
      '<div class="compare-col">' +
        '<div class="block-title">' + esc(meta.name) +
          ' <span class="badge">' + meta.badge + '</span></div>' +
        '<div class="metrics-row">' + renderMetricCards(result.stats) + '</div>' +
        '<div class="gantt-section">' +
          '<div class="gantt-label">⏱ 甘特图</div>' +
          '<div class="gantt-wrap"><div class="gantt">' + gantt + '</div>' +
          '<div class="gantt-times">' + times + '</div></div>' +
        '</div>' +
        '<div class="table-wrap">' + renderTable(result.processes, meta.needPriority) + '</div>' +
        renderOrder(result.timeline) +
      '</div>';
  }

  function renderSummary(algoA, algoB, sA, sB) {
    const metaA = S.ALGORITHMS[algoA];
    const metaB = S.ALGORITHMS[algoB];

    function best(a, b, lowerIsBetter) {
      if (Math.abs(a - b) < 1e-9) return ['', ''];
      if (lowerIsBetter) return a < b ? ['best', ''] : ['', 'best'];
      return a > b ? ['best', ''] : ['', 'best'];
    }

    const t = best(sA.avgTurnaround, sB.avgTurnaround, true);
    const w = best(sA.avgWaiting, sB.avgWaiting, true);
    const u = best(sA.utilization, sB.utilization, false);

    const diff = sA.avgTurnaround - sB.avgTurnaround;
    let conclusion;
    if (Math.abs(diff) < 1e-9) {
      conclusion = metaA.badge + ' 与 ' + metaB.badge + ' 的平均周转时间相同。';
    } else if (diff > 0) {
      conclusion = metaB.badge + ' 的平均周转时间比 ' + metaA.badge +
        ' 少 <b>' + diff.toFixed(2) + '</b>，本组数据下 ' + metaB.badge + ' 更优。';
    } else {
      conclusion = metaA.badge + ' 的平均周转时间比 ' + metaB.badge +
        ' 少 <b>' + (-diff).toFixed(2) + '</b>，本组数据下 ' + metaA.badge + ' 更优。';
    }

    return '' +
      '<div class="compare-summary">' +
        '<div class="compare-summary-title">⚡ 性能对比总览</div>' +
        '<div class="summary-grid">' +
          '<div class="cell head">指标</div>' +
          '<div class="cell head">' + metaA.badge + '</div>' +
          '<div class="cell head">' + metaB.badge + '</div>' +

          '<div class="cell label">平均周转时间</div>' +
          '<div class="cell val ' + t[0] + '">' + sA.avgTurnaround.toFixed(2) + '</div>' +
          '<div class="cell val ' + t[1] + '">' + sB.avgTurnaround.toFixed(2) + '</div>' +

          '<div class="cell label">总周转时间</div>' +
          '<div class="cell val">' + sA.totalTurnaround + '</div>' +
          '<div class="cell val">' + sB.totalTurnaround + '</div>' +

          '<div class="cell label">平均等待时间</div>' +
          '<div class="cell val ' + w[0] + '">' + sA.avgWaiting.toFixed(2) + '</div>' +
          '<div class="cell val ' + w[1] + '">' + sB.avgWaiting.toFixed(2) + '</div>' +

          '<div class="cell label">平均响应时间</div>' +
          '<div class="cell val">' + sA.avgResponse.toFixed(2) + '</div>' +
          '<div class="cell val">' + sB.avgResponse.toFixed(2) + '</div>' +

          '<div class="cell label">CPU 利用率</div>' +
          '<div class="cell val ' + u[0] + '">' + sA.utilization.toFixed(1) + '%</div>' +
          '<div class="cell val ' + u[1] + '">' + sB.utilization.toFixed(1) + '%</div>' +

          '<div class="cell label">完成总时长</div>' +
          '<div class="cell val">' + sA.totalTime + '</div>' +
          '<div class="cell val">' + sB.totalTime + '</div>' +
        '</div>' +
        '<div class="compare-conclusion">' + conclusion + '</div>' +
      '</div>';
  }

  function runCompare() {
    const res = readProcesses();
    if (res.error) { toast(res.error); return; }

    const algoA = $('compareA').value;
    const algoB = $('compareB').value;
    if (algoA === algoB) { toast('请选择两个不同的算法进行对比'); return; }

    stopAnim();
    currentResult = null;
    currentSnapshots = null;
    currentSeconds = null;

    colorMap = new Map();
    res.list.forEach(function (p, i) {
      colorMap.set(p.name, COLORS[i % COLORS.length]);
    });

    const singleOpts = getOptions();
    const q = singleOpts.quantum || 2;
    const mlfqQ = singleOpts.mlfqQuanta || S.DEFAULT_QUANTA;

    function optsFor(algo) {
      if (algo === 'rr') return { quantum: q };
      if (algo === 'mlfq') return { mlfqQuanta: mlfqQ };
      return {};
    }

    let rA, rB;
    try {
      rA = S.run(res.list, algoA, optsFor(algoA));
      rB = S.run(res.list, algoB, optsFor(algoB));
    } catch (e) {
      toast(e.message);
      return;
    }

    $('resultArea').innerHTML =
      '<div class="result-block">' +
        '<div class="compare-grid">' +
          renderCompareColumn(algoA, rA) +
          renderCompareColumn(algoB, rB) +
        '</div>' +
        renderSummary(algoA, algoB, rA.stats, rB.stats) +
      '</div>';

    const meta = $('resultMeta');
    meta.textContent = S.ALGORITHMS[algoA].badge + ' / ' + S.ALGORITHMS[algoB].badge + ' 对比';
    meta.style.display = 'inline-flex';

    toast('对比完成', 'success');
  }

  /* ---------------------------------------------------------
   * 导出 CSV
   * ------------------------------------------------------- */
  function exportCSV() {
    if (!currentResult) { toast('请先执行一次调度'); return; }

    const meta = S.ALGORITHMS[currentResult.algorithm];
    const r = currentResult;
    const lines = [];

    lines.push('# 调度算法,' + meta.name + '(' + meta.badge + ')');
    lines.push('# 抢占方式,' + (meta.preemptive ? '抢占式' : '非抢占式'));
    if (r.quantum != null) {
      lines.push('# 时间片,' + (Array.isArray(r.quantum) ? r.quantum.join('|') : r.quantum));
    }
    lines.push('');
    lines.push('进程,到达时间,运行时间,优先级,开始时间,完成时间,周转时间,等待时间,响应时间');

    r.processes.forEach(function (p) {
      lines.push([
        p.name, p.arrival, p.burst, p.priority,
        p.start, p.finish, p.turnaround, p.waiting, p.response,
      ].join(','));
    });

    lines.push('');
    lines.push('平均周转时间,' + r.stats.avgTurnaround.toFixed(2));
    lines.push('平均等待时间,' + r.stats.avgWaiting.toFixed(2));
    lines.push('平均响应时间,' + r.stats.avgResponse.toFixed(2));
    lines.push('总周转时间,' + r.stats.totalTurnaround);
    lines.push('CPU利用率(%),' + r.stats.utilization.toFixed(2));
    lines.push('完成总时长,' + r.stats.totalTime);

    download('\uFEFF' + lines.join('\r\n'),
      'schedule-' + currentResult.algorithm + '.csv',
      'text/csv;charset=utf-8');
    toast('CSV 已导出', 'success');
  }

  /* ---------------------------------------------------------
   * 配置保存 / 导入
   * ------------------------------------------------------- */
  function exportConfig() {
    const res = readProcesses();
    if (res.error) { toast(res.error); return; }

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      processes: res.list,
    };
    download(JSON.stringify(payload, null, 2),
      'process-config.json', 'application/json;charset=utf-8');
    toast('配置已保存', 'success');
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = JSON.parse(e.target.result);
        const list = Array.isArray(data) ? data : data.processes;
        if (!Array.isArray(list) || !list.length) throw new Error('文件中没有进程数据');

        $('processList').innerHTML = '';
        rowSeq = 0;
        list.forEach(function (p) {
          addRow(p.name, p.arrival, p.burst, p.priority == null ? '' : p.priority);
        });
        toast('已导入 ' + list.length + ' 个进程', 'success');
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ---------------------------------------------------------
   * 经典测试用例下拉
   * ------------------------------------------------------- */
  function initPresets() {
    const sel = $('presetSelect');
    S.TEST_CASES.forEach(function (tc, i) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = tc.name;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', function () {
      if (this.value === '') return;
      const tc = S.TEST_CASES[parseInt(this.value, 10)];
      $('processList').innerHTML = '';
      rowSeq = 0;
      tc.processes.forEach(function (p) {
        addRow(p.name, p.arrival, p.burst, p.priority == null ? '' : p.priority);
      });
      this.value = '';
      toast('已载入：' + tc.name, 'success');
    });
  }

  /* ---------------------------------------------------------
   * 算法自检弹窗
   * ------------------------------------------------------- */
  function showVerify() {
    const result = S.verify();

    let html = '<div class="verify-summary ' + (result.allPassed ? 'ok' : 'fail') + '">' +
      (result.allPassed ? '✅' : '❌') + ' 通过 ' + result.passed + ' / ' + result.total +
      ' 项校验' + (result.allPassed ? '，所有算法与手算结果一致。' : '，存在不一致项，请检查。') +
      '</div>';

    html += '<table class="verify-table"><thead><tr>' +
      '<th>用例 / 算法</th>' +
      '<th>期望平均周转</th><th>实际平均周转</th>' +
      '<th>期望平均等待</th><th>实际平均等待</th>' +
      '<th>结果</th></tr></thead><tbody>';

    let lastCase = null;
    result.rows.forEach(function (r) {
      if (r.caseName !== lastCase) {
        html += '<tr><td colspan="6" style="text-align:left;' +
          'background:var(--bg-input);font-weight:700;font-size:12px;">' +
          esc(r.caseName) + '</td></tr>';
        lastCase = r.caseName;
      }
      html += '<tr>' +
        '<td>' + r.badge + '</td>' +
        '<td class="mono">' + r.expectedTurnaround.toFixed(2) + '</td>' +
        '<td class="mono">' + (isNaN(r.actualTurnaround) ? '—' : r.actualTurnaround.toFixed(2)) + '</td>' +
        '<td class="mono">' + r.expectedWaiting.toFixed(2) + '</td>' +
        '<td class="mono">' + (isNaN(r.actualWaiting) ? '—' : r.actualWaiting.toFixed(2)) + '</td>' +
        '<td class="' + (r.pass ? 'ok' : 'fail') + '">' + (r.pass ? '✓' : '✗') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';

    $('verifyBody').innerHTML = html;
    $('verifyModal').classList.add('show');
  }

  /* ---------------------------------------------------------
   * 事件绑定 & 初始化
   * ------------------------------------------------------- */
  function init() {
    initAlgoPills();
    initCompareSelects();
    initPresets();
    syncQuantumField();

    $('btnAdd').addEventListener('click', function () {
      const n = $$('#processList .process-chip').length;
      addRow('P' + (n + 1), '', '', '');
    });
    $('btnClear').addEventListener('click', clearAll);
    $('btnRun').addEventListener('click', run);
    $('btnCompare').addEventListener('click', runCompare);
    $('btnExportCsv').addEventListener('click', exportCSV);
    $('btnExportCfg').addEventListener('click', exportConfig);
    $('btnVerify').addEventListener('click', showVerify);
    $('btnCloseVerify').addEventListener('click', function () {
      $('verifyModal').classList.remove('show');
    });
    $('verifyModal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('show');
    });

    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) {
        importConfig(this.files[0]);
        this.value = '';
      }
    });

    $('btnSwap').addEventListener('click', function () {
      const a = $('compareA'), b = $('compareB');
      const tmp = a.value;
      a.value = b.value;
      b.value = tmp;
    });

    addRow('P1', 0, 7, 3);
    addRow('P2', 2, 4, 1);
    addRow('P3', 4, 1, 4);
    addRow('P4', 5, 4, 2);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();