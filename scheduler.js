/* =========================================================
 * scheduler.js —— CPU 调度算法核心库（纯函数，零 DOM 依赖）
 * 可在 Node 中直接 require 测试：
 *   const S = require('./scheduler.js');
 *   console.log(S.run([{name:'P1',arrival:0,burst:7}, ...], 'fcfs'));
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Scheduler = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALGORITHMS = {
    fcfs:  { name: '先来先服务',     badge: 'FCFS',   preemptive: false, needPriority: false, needQuantum: false },
    sjf:   { name: '短进程优先',     badge: 'SJF',    preemptive: false, needPriority: false, needQuantum: false },
    srtf:  { name: '最短剩余时间',   badge: 'SRTF',   preemptive: true,  needPriority: false, needQuantum: false },
    rr:    { name: '时间片轮转',     badge: 'RR',     preemptive: true,  needPriority: false, needQuantum: true  },
    hrrn:  { name: '最高响应比优先', badge: 'HRRN',   preemptive: false, needPriority: false, needQuantum: false },
    prio:  { name: '优先级调度',     badge: 'PRIO',   preemptive: false, needPriority: true,  needQuantum: false },
    priop: { name: '抢占式优先级',   badge: 'PRIO-P', preemptive: true,  needPriority: true,  needQuantum: false },
    mlfq:  { name: '多级反馈队列',   badge: 'MLFQ',   preemptive: true,  needPriority: false, needQuantum: true  },
  };

  const DEFAULT_QUANTA = [2, 4, 8];

  function makeProcs(inputs) {
    return inputs.map(function (p, i) {
      return {
        name: String(p.name),
        arrival: Math.floor(p.arrival),
        burst: Math.max(1, Math.floor(p.burst)),
        priority: p.priority == null ? 0 : Math.floor(p.priority),
        idx: i,
        remaining: Math.max(1, Math.floor(p.burst)),
        start: null,
        finish: null,
        level: 0,
      };
    });
  }

  const byArrival = (a, b) => a.arrival - b.arrival || a.idx - b.idx;
  const tieBreak  = (a, b) => a.arrival - b.arrival || a.idx - b.idx;

  function push(raw, start, end, name) {
    if (end <= start) return;
    raw.push({ start: start, end: end, name: name });
  }

  function compact(raw) {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const last = out[out.length - 1];
      if (last && last.name === s.name && last.end === s.start) {
        last.end = s.end;
      } else {
        out.push({ name: s.name, start: s.start, end: s.end });
      }
    }
    return out;
  }

  function nonPreemptive(inputs, pick) {
    const ps = makeProcs(inputs);
    const raw = [];
    let t = 0, done = 0;
    const n = ps.length;

    while (done < n) {
      const pending = ps.filter(p => p.remaining > 0);
      const ready = pending.filter(p => p.arrival <= t);

      if (ready.length === 0) {
        const next = Math.min.apply(null, pending.map(p => p.arrival));
        push(raw, t, next, null);
        t = next;
        continue;
      }

      const p = pick(ready, t);
      p.start = t;
      push(raw, t, t + p.remaining, p.name);
      t += p.remaining;
      p.remaining = 0;
      p.finish = t;
      done++;
    }
    return { ps: ps, raw: raw, quantum: null };
  }

  function pickSJF(ready) {
    ready.sort((a, b) => a.remaining - b.remaining || tieBreak(a, b));
    return ready[0];
  }

  function pickHRRN(ready, now) {
    const ratio = p => (now - p.arrival + p.burst) / p.burst;
    ready.sort((a, b) => ratio(b) - ratio(a) || tieBreak(a, b));
    return ready[0];
  }

  function pickPrio(ready) {
    ready.sort((a, b) => a.priority - b.priority || tieBreak(a, b));
    return ready[0];
  }

  function preemptive(inputs, compare) {
    const ps = makeProcs(inputs);
    const raw = [];
    let t = 0, done = 0;
    const n = ps.length;

    while (done < n) {
      const pending = ps.filter(p => p.remaining > 0);
      const ready = pending.filter(p => p.arrival <= t);

      if (ready.length === 0) {
        const next = Math.min.apply(null, pending.map(p => p.arrival));
        push(raw, t, next, null);
        t = next;
        continue;
      }

      ready.sort(compare);
      const cur = ready[0];

      let end = t + cur.remaining;
      for (let i = 0; i < pending.length; i++) {
        const q = pending[i];
        if (q === cur || q.arrival <= t || q.arrival >= end) continue;
        const curRemAt = cur.remaining - (q.arrival - t);
        if (compare(
              { remaining: q.remaining, priority: q.priority, arrival: q.arrival, idx: q.idx },
              { remaining: curRemAt,   priority: cur.priority, arrival: cur.arrival, idx: cur.idx }
            ) < 0) {
          end = q.arrival;
        }
      }

      if (cur.start === null) cur.start = t;
      push(raw, t, end, cur.name);
      cur.remaining -= (end - t);
      t = end;

      if (cur.remaining === 0) {
        cur.finish = t;
        done++;
      }
    }
    return { ps: ps, raw: raw, quantum: null };
  }

  const cmpRemaining = (a, b) => a.remaining - b.remaining || tieBreak(a, b);
  const cmpPriority  = (a, b) => a.priority  - b.priority  || tieBreak(a, b);

  function rr(inputs, quantum) {
    const q = Math.max(1, quantum || 2);
    const ps = makeProcs(inputs);
    const sorted = ps.slice().sort(byArrival);
    const raw = [];
    const queue = [];
    let t = 0, done = 0, idx = 0;
    const n = ps.length;

    while (done < n) {
      while (idx < sorted.length && sorted[idx].arrival <= t) {
        queue.push(sorted[idx++]);
      }
      if (queue.length === 0) {
        push(raw, t, sorted[idx].arrival, null);
        t = sorted[idx].arrival;
        continue;
      }

      const p = queue.shift();
      if (p.start === null) p.start = t;

      const run = Math.min(q, p.remaining);
      push(raw, t, t + run, p.name);
      t += run;
      p.remaining -= run;

      while (idx < sorted.length && sorted[idx].arrival <= t) {
        queue.push(sorted[idx++]);
      }

      if (p.remaining === 0) { p.finish = t; done++; }
      else queue.push(p);
    }
    return { ps: ps, raw: raw, quantum: q };
  }

  function mlfq(inputs, quanta) {
    const Q = (quanta && quanta.length ? quanta.slice() : DEFAULT_QUANTA.slice());
    const levels = Q.length;
    const ps = makeProcs(inputs);
    const sorted = ps.slice().sort(byArrival);
    const queues = [];
    for (let i = 0; i < levels; i++) queues.push([]);

    const raw = [];
    let t = 0, done = 0, idx = 0;
    const n = ps.length;

    while (done < n) {
      while (idx < sorted.length && sorted[idx].arrival <= t) {
        const p = sorted[idx++];
        p.level = 0;
        queues[0].push(p);
      }

      let L = -1;
      for (let i = 0; i < levels; i++) {
        if (queues[i].length) { L = i; break; }
      }

      if (L === -1) {
        const nextArr = sorted[idx] ? sorted[idx].arrival : null;
        if (nextArr === null) break;
        push(raw, t, nextArr, null);
        t = nextArr;
        continue;
      }

      const p = queues[L].shift();
      if (p.start === null) p.start = t;

      const run = Math.min(Q[L], p.remaining);
      push(raw, t, t + run, p.name);
      t += run;
      p.remaining -= run;

      while (idx < sorted.length && sorted[idx].arrival <= t) {
        const q = sorted[idx++];
        q.level = 0;
        queues[0].push(q);
      }

      if (p.remaining === 0) {
        p.finish = t;
        done++;
      } else {
        p.level = Math.min(L + 1, levels - 1);
        queues[p.level].push(p);
      }
    }
    return { ps: ps, raw: raw, quantum: Q };
  }

  function buildResult(ps, raw, algorithm, quantum) {
    const timeline = compact(raw);
    const totalTime = timeline.length ? timeline[timeline.length - 1].end : 0;

    const processes = ps.map(function (p) {
      const turnaround = p.finish - p.arrival;
      const waiting = turnaround - p.burst;
      const response = (p.start === null ? p.finish : p.start) - p.arrival;
      return {
        name: p.name, arrival: p.arrival, burst: p.burst, priority: p.priority,
        start: p.start, finish: p.finish,
        turnaround: turnaround, waiting: waiting, response: response,
        level: p.level,
      };
    });

    const n = processes.length || 1;
    const sum = f => processes.reduce((s, p) => s + f(p), 0);
    const busy = processes.reduce((s, p) => s + p.burst, 0);

    const stats = {
      avgTurnaround: sum(p => p.turnaround) / n,
      avgWaiting: sum(p => p.waiting) / n,
      avgResponse: sum(p => p.response) / n,
      totalTurnaround: sum(p => p.turnaround),
      totalWaiting: sum(p => p.waiting),
      totalTime: totalTime,
      busy: busy,
      utilization: totalTime > 0 ? (busy / totalTime) * 100 : 0,
      throughput: totalTime > 0 ? processes.length / totalTime : 0,
    };

    return {
      algorithm: algorithm, quantum: quantum,
      timeline: timeline, processes: processes, stats: stats,
    };
  }

  function run(inputs, algorithm, options) {
    options = options || {};
    if (!ALGORITHMS[algorithm]) throw new Error('未知调度算法：' + algorithm);
    if (!inputs || !inputs.length) throw new Error('进程列表为空');

    let res;
    switch (algorithm) {
      case 'fcfs':  res = nonPreemptive(inputs, function (ready) {
                      ready.sort(byArrival); return ready[0];
                    }); break;
      case 'sjf':   res = nonPreemptive(inputs, pickSJF);  break;
      case 'hrrn':  res = nonPreemptive(inputs, pickHRRN); break;
      case 'prio':  res = nonPreemptive(inputs, pickPrio); break;
      case 'srtf':  res = preemptive(inputs, cmpRemaining); break;
      case 'priop': res = preemptive(inputs, cmpPriority);  break;
      case 'rr':    res = rr(inputs, options.quantum || 2); break;
      case 'mlfq':  res = mlfq(inputs, options.mlfqQuanta); break;
      default: throw new Error('未实现：' + algorithm);
    }
    return buildResult(res.ps, res.raw, algorithm, res.quantum);
  }

  function buildSnapshots(result) {
    const remain = new Map();
    result.processes.forEach(p => remain.set(p.name, p.burst));

    const snapshots = [];
    for (let i = 0; i < result.timeline.length; i++) {
      const seg = result.timeline[i];

      const ready = [];
      for (let j = 0; j < result.processes.length; j++) {
        const p = result.processes[j];
        if (p.name === seg.name) continue;
        if (p.arrival > seg.start) continue;
        const r = remain.get(p.name);
        if (r <= 0) continue;
        ready.push({ name: p.name, remaining: r });
      }
      ready.sort(function (a, b) {
        const pa = result.processes.find(x => x.name === a.name);
        const pb = result.processes.find(x => x.name === b.name);
        return pa.arrival - pb.arrival || a.name.localeCompare(b.name);
      });

      snapshots.push({
        time: seg.start,
        running: seg.name,
        runningRemaining: seg.name === null ? 0 : remain.get(seg.name),
        ready: ready,
      });

      if (seg.name !== null) {
        remain.set(seg.name, remain.get(seg.name) - (seg.end - seg.start));
      }
    }
    return snapshots;
  }

  /* ---------------------------------------------------------
   * 经典测试用例（供下拉菜单快速载入，不再用于自检）
   * ------------------------------------------------------- */
  const TEST_CASES = [
    {
      name: '用例 A（4 进程，错开到达到）',
      processes: [
        { name: 'P1', arrival: 0, burst: 7, priority: 3 },
        { name: 'P2', arrival: 2, burst: 4, priority: 1 },
        { name: 'P3', arrival: 4, burst: 1, priority: 4 },
        { name: 'P4', arrival: 5, burst: 4, priority: 2 },
      ],
    },
    {
      name: '用例 B（3 进程，全部同时到达）',
      processes: [
        { name: 'P1', arrival: 0, burst: 24 },
        { name: 'P2', arrival: 0, burst: 3 },
        { name: 'P3', arrival: 0, burst: 3 },
      ],
    },
    {
      name: '用例 C（5 进程，优先级验证）',
      processes: [
        { name: 'P1', arrival: 0, burst: 10, priority: 3 },
        { name: 'P2', arrival: 1, burst: 1,  priority: 1 },
        { name: 'P3', arrival: 2, burst: 2,  priority: 4 },
        { name: 'P4', arrival: 3, burst: 1,  priority: 5 },
        { name: 'P5', arrival: 4, burst: 5,  priority: 2 },
      ],
    },
  ];

  return {
    ALGORITHMS: ALGORITHMS,
    DEFAULT_QUANTA: DEFAULT_QUANTA,
    TEST_CASES: TEST_CASES,
    run: run,
    buildSnapshots: buildSnapshots,
    _compact: compact,
  };
});