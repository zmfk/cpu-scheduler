# CPU Scheduler - CPU 调度算法模拟器

一个纯前端的 CPU 调度算法可视化模拟器，支持 8 种经典调度算法、逐秒动画演示、算法对比、甘特图绘制、指标统计与 CSV 导出。核心调度逻辑以纯函数方式封装，可在浏览器与 Node.js 中复用。

---

## 功能特性

- 8 种经典调度算法：FCFS、SJF、SRTF、RR、HRRN、PRIO、PRIO-P、MLFQ
- 逐步动画演示：以「每秒一格」的粒度逐秒播放，实时展示时钟、运行中进程、就绪队列与剩余时间
- 甘特图与调度顺序：动态延展的甘特图，自动生成调度顺序流程图
- 动态指标卡与结果表：随播放进度实时显现平均周转 / 等待 / 响应时间、CPU 利用率
- 算法对比：任意两种算法左右并排对比，自动标出更优指标并给出结论
- 配置管理：进程列表增删改、经典测试用例一键载入、JSON 配置导入导出
- 结果导出：一键导出包含详细数据与统计指标的 CSV（Excel 友好，带 BOM）
- 主题切换：浅色 / 深色主题，偏好持久化到 localStorage
- 响应式布局：适配桌面与移动端

---

## 项目结构

```text
.
├── index.html       # 页面结构
├── style.css        # 样式（含深色主题、动画、响应式）
├── scheduler.js     # 调度算法核心库（纯函数，零 DOM 依赖，可 Node 复用）
└── app.js           # UI 层（DOM 绑定、渲染、动画、导入导出）
```

---

## 快速开始

### 浏览器

直接双击打开 index.html 即可（无需构建、无依赖）。

若需使用导入 / 导出功能，建议通过本地服务器访问以避免部分浏览器的 file:// 限制：

```bash
# 任选其一
python3 -m http.server 8000
npx serve .
```

### Node.js 中使用核心库

scheduler.js 采用 UMD 封装，可直接在 Node 中测试：

```js
const S = require('./scheduler.js');

const procs = [
  { name: 'P1', arrival: 0, burst: 7, priority: 3 },
  { name: 'P2', arrival: 2, burst: 4, priority: 1 },
  { name: 'P3', arrival: 4, burst: 1, priority: 4 },
  { name: 'P4', arrival: 5, burst: 4, priority: 2 },
];

const result = S.run(procs, 'srtf');
console.log(result.stats);
console.log(result.timeline);
```

---

## 支持的调度算法

| Key     | 名称             | 缩写    | 抢占 | 需优先级 | 需时间片 |
| ------- | ---------------- | ------- | ---- | -------- | -------- |
| fcfs    | 先来先服务       | FCFS    | 否   | 否       | 否       |
| sjf     | 短进程优先       | SJF     | 否   | 否       | 否       |
| srtf    | 最短剩余时间     | SRTF    | 是   | 否       | 否       |
| rr      | 时间片轮转       | RR      | 是   | 否       | 是       |
| hrrn    | 最高响应比优先   | HRRN    | 否   | 否       | 否       |
| prio    | 优先级调度       | PRIO    | 否   | 是       | 否       |
| priop   | 抢占式优先级     | PRIO-P  | 是   | 是       | 否       |
| mlfq    | 多级反馈队列     | MLFQ    | 是   | 否       | 是       |

优先级约定：数值越小优先级越高（1 高于 2）。

平局规则：先比较到达时间，再比较输入顺序（越靠前的进程优先级越高）。

MLFQ：默认三级队列，时间片为 [2, 4, 8]，可在 UI 中以逗号分隔自定义（如 1,2,4）。

---

## 使用说明

### 1. 配置进程

在「配置进程」区域：

- 点击「添加」新增进程行
- 依次填写 进程名 / 到达时间 / 运行时间 / 优先级
  - 到达时间：非负整数
  - 运行时间：正整数
  - 优先级：非负整数（仅 PRIO / PRIO-P 生效）
- 点击进程行右侧「删除」按钮删除
- 使用「经典测试用例...」下拉一键载入示例
- 「导入 / 保存配置」支持 JSON 格式的配置读写

### 2. 选择算法

- 点击算法胶囊切换算法
- RR 需填写「时间片」；MLFQ 需填写「各级时间片」（逗号分隔）
- 点击「开始调度」运行并自动播放动画

### 3. 查看结果

- 播放控制：播放 / 暂停 / 重播 / 重置，速度可选 2s、1s、0.5s 每秒
- 时钟面板：实时显示当前时刻、运行中进程及其剩余时间、就绪队列
- 逐步时间轴：每秒一格，逐格闪入
- 甘特图：按比例延展，悬停显示区间详情
- 指标卡 / 结果表：随播放进度动态显现

### 4. 算法对比

在「算法对比」区域选择两种算法，点击「对比」：

- 左右并排展示各自的甘特图、指标与结果表
- 底部汇总表自动用星标标出更优的指标
- 根据平均周转时间给出结论文字
- 点击「交换」可交换左右算法

### 5. 导出

- 「导出 CSV」：导出当前调度结果的进程明细与统计指标

---

## 数据格式

### 进程对象

```json
{
  "name": "P1",
  "arrival": 0,
  "burst": 7,
  "priority": 3
}
```

### 配置文件（导入 / 导出）

```json
{
  "version": 1,
  "exportedAt": "2025-01-01T00:00:00.000Z",
  "processes": [
    { "name": "P1", "arrival": 0, "burst": 7, "priority": 3 }
  ]
}
```

导入时也兼容直接传入进程数组 `[{...}, {...}]`。

---

## API 参考（scheduler.js）

### S.ALGORITHMS

算法元数据字典，键为算法 key，值为 `{ name, badge, preemptive, needPriority, needQuantum }`。

### S.DEFAULT_QUANTA

MLFQ 默认时间片数组：`[2, 4, 8]`。

### S.TEST_CASES

内置经典测试用例数组：`[{ name, processes }, ...]`。

### S.run(inputs, algorithm, options?)

执行调度，返回结果对象。

- inputs：`Array<{ name, arrival, burst, priority? }>`
- algorithm：算法 key（见上表）
- options：
  - `quantum?: number`：RR 时间片（默认 2）
  - `mlfqQuanta?: number[]`：MLFQ 各级时间片（默认 [2, 4, 8]）

返回值：

```js
{
  algorithm: 'srtf',
  quantum: null,                 // 数字 / 数组 / null
  timeline: [                    // 压缩后的时间片（空闲段 name 为 null）
    { name: 'P1', start: 0, end: 2 },
    { name: null, start: 2, end: 3 },
    ...
  ],
  processes: [{
    name, arrival, burst, priority,
    start, finish,
    turnaround,  // 周转时间 = finish - arrival
    waiting,     // 等待时间 = turnaround - burst
    response,    // 响应时间 = start - arrival
    level,       // MLFQ 最终所在队列层级
  }],
  stats: {
    avgTurnaround, avgWaiting, avgResponse,
    totalTurnaround, totalWaiting,
    totalTime,                 // 完成总时长
    busy,                      // CPU 忙碌时间 = Σ burst
    utilization,               // CPU 利用率（%）
    throughput,                // 吞吐率 = 进程数 / totalTime
  },
}
```

### S.buildSnapshots(result)

将结果展开为逐时间片快照，便于自定义可视化：

```js
[{
  time,              // 该段起始时刻
  running,           // 运行中进程名（空闲为 null）
  runningRemaining,  // 该时刻剩余时间
  ready: [{ name, remaining }],  // 就绪队列
}, ...]
```

---

## 技术要点

- 零依赖：纯原生 HTML / CSS / JavaScript，无需构建工具
- 关注点分离：scheduler.js 为纯函数库，不触碰任何 DOM，便于单元测试与复用
- 时间轴动画：采用 requestAnimationFrame 驱动，按「每秒一格」逐格追加并触发闪光动画；甘特图则按已揭示秒数裁剪，避免重绘闪烁
- 颜色映射：按进程输入顺序从预置调色板分配颜色，全程一致
- 主题系统：基于 CSS 变量，切换 data-theme 属性即可全局换肤

---

## 内置测试用例

| 名称                           | 描述                                |
| ------------------------------ | ----------------------------------- |
| 用例 A（4 进程，错开到达到）   | 验证抢占 / 非抢占下的响应差异       |
| 用例 B（3 进程，全部同时到达） | 经典 SJF 对比 FCFS 场景             |
| 用例 C（5 进程，优先级验证）   | 验证 PRIO / PRIO-P 的优先级选择逻辑 |

---

## License

MIT