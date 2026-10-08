/* =========================================================
 * scheduler.js —— CPU 调度算法核心库（纯函数，零 DOM 依赖）
 * 可在 Node 中直接 require 测试：
 *   const S = require('./scheduler.js');
 *   console.log(S.run([{name:'P1',arrival:0,burst:7}, ...], 'fcfs'));
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // Node
  } else {
    root.Scheduler = factory();          // 浏览器
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------
   * 1. 算法元数据
   * ------------------------------------------------------- */
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

  const DEFAULT_QUANTA = [2, 4, 8];   // MLFQ 三级队列时间片

  /* ---------------------------------------------------------
   * 2. 内部工具
   * ------------------------------------------------------- */
  function makeProcs(inputs) {
    return inputs.map(function (p, i) {
      return {
        name: String(p.name),
        arrival: Math.floor(p.arrival),
        burst: Math.max(1, Math.floor(p.burst)),
        priority: p.priority == null ? 0 : Math.floor(p.priority),
        idx: i,                        // 输入顺序 —— 平局的最终裁决者
        remaining: Math.max(1, Math.floor(p.burst)),
        start: null,
        finish: null,
        level: 0,
      };
    });
  }

  /* 统一平局规则：到达时间 → 输入顺序 */
  const byArrival = (a, b) => a.arrival - b.arrival || a.idx - b.idx;
  const tieBreak  = (a, b) => a.arrival - b.arrival || a.idx - b.idx;

  function push(raw, start, end, name) {
    if (end <= start) return;
    raw.push({ start: start, end: end, name: name });
  }

  /**
   * 性能优化核心：把逐单位的原始区间合并成连续段。
   * [P1:0-1, P1:1-2, P1:2-3] → [P1:0-3]
   */
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

  /* ---------------------------------------------------------
   * 3. 非抢占式调度统一框架
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 4. 抢占式调度统一框架
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 5. 时间片轮转 RR
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 6. 多级反馈队列 MLFQ
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 7. 结果组装
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 8. 对外主入口
   * ------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   * 9. 就绪队列快照（供 UI 播放使用）
   * ------------------------------------------------------- */
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
   * 10. 经典测试用例（含手算期望值 —— 已修正）
   * ------------------------------------------------------- */
  const TEST_CASES = [
    {
      name: '经典用例 A（4 进程，错开到达到）',
      processes: [
        { name: 'P1', arrival: 0, burst: 7, priority: 3 },
        { name: 'P2', arrival: 2, burst: 4, priority: 1 },
        { name: 'P3', arrival: 4, burst: 1, priority: 4 },
        { name: 'P4', arrival: 5, burst: 4, priority: 2 },
      ],
      /*
       * 手算过程（详见实验报告「数据处理」章节）：
       * FCFS:  P1(0-7)  P2(7-11) P3(11-12) P4(12-16)
       *        周转 7,9,8,11  → 平均 8.75；等待 0,5,7,7  → 平均 4.75
       * SJF :  P1(0-7)  P3(7-8)  P2(8-12) P4(12-16)
       *        周转 7,10,4,11 → 平均 8.00；等待 0,6,3,7  → 平均 4.00
       * SRTF:  P1(0-2) P2(2-4) P3(4-5) P2(5-7) P4(7-11) P1(11-16)
       *        周转 16,5,1,6  → 平均 7.00；等待 9,1,0,2  → 平均 3.00
       * HRRN:  P1(0-7) P3(7-8) P2(8-12) P4(12-16)
       *        周转 7,10,4,11 → 平均 8.00；等待 0,6,3,7  → 平均 4.00
       * RR(q=2): P1(0-2) P2(2-4) P1(4-6) P3(6-7)
       *          P2(7-9) P4(9-11) P1(11-13) P4(13-15) P1(15-16)
       *          周转 16,7,3,10 → 平均 9.00；等待 9,3,2,6  → 平均 5.00
       */
      expected: {
        fcfs: { avgTurnaround: 8.75, avgWaiting: 4.75 },
        sjf:  { avgTurnaround: 8.00, avgWaiting: 4.00 },
        srtf: { avgTurnaround: 7.00, avgWaiting: 3.00 },
        hrrn: { avgTurnaround: 8.00, avgWaiting: 4.00 },
        rr:   { avgTurnaround: 9.00, avgWaiting: 5.00, quantum: 2 },
      },
    },
    {
      name: '经典用例 B（3 进程，全部同时到达）',
      processes: [
        { name: 'P1', arrival: 0, burst: 24 },
        { name: 'P2', arrival: 0, burst: 3 },
        { name: 'P3', arrival: 0, burst: 3 },
      ],
      /*
       * FCFS:   P1(0-24) P2(24-27) P3(27-30)
       *         周转 24,27,30   → 平均 27.0；等待 0,24,27  → 平均 17.0
       * SJF :   P2(0-3)  P3(3-6)   P1(6-30)
       *         周转 3,6,30     → 平均 13.0；等待 0,3,6    → 平均 3.0
       * SRTF:   同 SJF → 13.0 / 3.0
       * RR(4):  P1(0-4) P2(4-7) P3(7-10) P1(10-30)
       *         周转 30,7,10    → 平均 47/3；等待 6,4,7  → 平均 17/3
       */
      expected: {
        fcfs: { avgTurnaround: 27.0,   avgWaiting: 17.0 },
        sjf:  { avgTurnaround: 13.0,   avgWaiting: 3.0  },
        srtf: { avgTurnaround: 13.0,   avgWaiting: 3.0  },
        rr:   { avgTurnaround: 47 / 3, avgWaiting: 17 / 3, quantum: 4 },
      },
    },
    {
      name: '经典用例 C（优先级调度验证）',
      processes: [
        { name: 'P1', arrival: 0, burst: 10, priority: 3 },
        { name: 'P2', arrival: 1, burst: 1,  priority: 1 },
        { name: 'P3', arrival: 2, burst: 2,  priority: 4 },
        { name: 'P4', arrival: 3, burst: 1,  priority: 5 },
        { name: 'P5', arrival: 4, burst: 5,  priority: 2 },
      ],
      /*
       * PRIO（非抢占，数值小者优先）：
       *   P1(0-10) P2(10-11) P5(11-16) P3(16-18) P4(18-19)
       *   周转 10,10,16,16,12 → 平均 12.8；等待 0,9,14,15,7 → 平均 9.0
       */
      expected: {
        prio: { avgTurnaround: 12.8, avgWaiting: 9.0 },
      },
    },
  ];

  /* ---------------------------------------------------------
   * 11. 自检：跑全部用例，与手算结果比对
   * ------------------------------------------------------- */
  function verify(tolerance) {
    const tol = tolerance == null ? 1e-9 : tolerance;
    const rows = [];

    TEST_CASES.forEach(function (tc) {
      Object.keys(tc.expected).forEach(function (algo) {
        const exp = tc.expected[algo];
        const opts = {};
        if (exp.quantum != null) opts.quantum = exp.quantum;
        if (exp.mlfqQuanta != null) opts.mlfqQuanta = exp.mlfqQuanta;

        let actual = null, err = null;
        try {
          actual = run(tc.processes, algo, opts);
        } catch (e) {
          err = e.message;
        }

        const okT = !err && Math.abs(actual.stats.avgTurnaround - exp.avgTurnaround) < tol;
        const okW = !err && Math.abs(actual.stats.avgWaiting - exp.avgWaiting) < tol;

        rows.push({
          caseName: tc.name,
          algorithm: algo,
          badge: ALGORITHMS[algo].badge,
          expectedTurnaround: exp.avgTurnaround,
          actualTurnaround: err ? NaN : actual.stats.avgTurnaround,
          expectedWaiting: exp.avgWaiting,
          actualWaiting: err ? NaN : actual.stats.avgWaiting,
          pass: okT && okW,
          error: err,
        });
      });
    });

    return {
      rows: rows,
      passed: rows.filter(r => r.pass).length,
      total: rows.length,
      allPassed: rows.every(r => r.pass),
    };
  }

  /* ---------------------------------------------------------
   * 12. 导出
   * ------------------------------------------------------- */
  return {
    ALGORITHMS: ALGORITHMS,
    DEFAULT_QUANTA: DEFAULT_QUANTA,
    TEST_CASES: TEST_CASES,
    run: run,
    buildSnapshots: buildSnapshots,
    verify: verify,
    _compact: compact,
  };
});