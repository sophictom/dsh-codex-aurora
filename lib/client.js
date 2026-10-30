/**
 * dsh-codex-aurora — 客户端半边
 *
 * 把 DSH 官方模型菜单里的**「推理等级」那一行**改造成 Codex 风格滑条：
 *   · 那一行加高上下内距、允许折行，滑条作为第二行铺满整行宽度
 *   · 普通档位一律纯蓝 #339CFF；**只有最高档**才是紫色渐变 + 缓慢游走的极光 + 匀速横移的星点
 *   · 最高档 = 静止底色 + 两层以不同周期摆动的柔光（颜色"在轻微变化"）+ 三层星带匀速左移
 *   · 星点**亮度恒定**、只移动不闪烁（实机录屏逐帧量取：位置随时间平移、亮度无亮灭）
 *   · 输入框工具行**不加任何东西**（原来的胶囊已撤掉）
 *
 * ── 官方那一行的确切形状（来自 app.asar 源码，本插件用到的锚点）──────────
 *
 *   席（官方 ModelSelect 的 trigger）：
 *     <button aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-menu`}>
 *   菜单（portal 到 body 的 MenuSurface）：
 *     <… role="menu" id={`${id}-menu`}>                       ← 用 aria-controls + id 定位，比 class 稳
 *       <button role="menuitem"> 模型 … </button>              ← 根面板**只有**两个 menuitem
 *       <button role="menuitem"> 推理等级 <span>High</span> <svg/> </button>   ← 目标行
 *   子面板（模型列表 / 等级列表）用的是 `menuitemradio`，所以
 *   `button[role="menuitem"]` 恰好唯一标识根面板那两行 —— 这是本插件的主锚点。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────
 *  1. **只动那一行**：只写 4 个内联样式（height/flex-wrap/padding-block）+ 往行里 append 一个容器；
 *     关菜单或卸载时逐个还原，不碰官方其它 DOM、不碰官方 class。
 *  2. **fail-open**：任何一步找不到（没有 aria-controls、菜单没有两个 menuitem、会话作用域没就绪…）
 *     就什么都不做 —— 官方菜单保持原样，绝不因为本插件而点不开。
 *  3. **绝不注入消息**：不监听 agent/pre-step、不 append 会话事件、不构造消息
 *     （同类插件在这里踩过 V4 会话准入的坑，本插件结构上不存在这条路）。
 */
window.__ModuleLoader__.load({
  id: "dsh-codex-aurora",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    var PACKAGE_ID = "dsh-codex-aurora";
    /** 仍然注册一个（不可见的）插槽条目：它是**每会话**拿到 sessionId 与 ctx 的立足点。 */
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "codex-aurora";
    var ENTRY_ORDER = 40;
    /** 「加高那一栏的上下距离」。 */
    var ROW_PADDING_BLOCK = "10px";
    /** 官方那一行的中文/英文文案（形状锚点之一；认不出就按官方固定顺序取第 2 个 menuitem）。 */
    var EFFORT_ROW_LABELS = ["推理等级", "Effort"];
    /** 拖动期间的写回降频窗口（毫秒）。松手一律立即落地。 */
    var COMMIT_THROTTLE_MS = 120;
    /** 提交后等宿主真实回报的上限；超时回滚并提示，不继续假装已生效。 */
    var COMMIT_DEADLINE_MS = 10000;
    /** 目录解析失败时的退避重试序列（毫秒，累计约 9 秒）。 */
    var RETRY_DELAYS = [60, 240, 540, 960, 1500, 3000, 3000];
    var STYLE_MARKER = PACKAGE_ID;

    /* ── 尺寸与速率常量：**必须声明在 CSS 数组之前**，因为样式表要插值它们 ──
       （踩过一次：CSS 数组先于常量求值，样式里写进去的是 `height:undefinedpx`，
       真机上轨道会塌成 0 高。测试里对轨道高/旋钮直径的断言就是为这个加的。） */
    /**
     * 轨道高度（px）。实机量取：轨道 36、旋钮 40 —— **旋钮比轨道高 4px**，
     * 上下各溢出 2px，所以条子看起来比旋钮"细一圈"。这里按同一比例缩到 24/28。
     */
    var TRACK_HEIGHT = 24;
    var KNOB_SIZE = 28;
    /** 旋钮半径。圆心在两端各留出这个半径，圆圈才不会顶出轨道被菜单裁掉。 */
    var KNOB_RADIUS = KNOB_SIZE / 2;
    /** 全局速率倍数（用户要求：所有速度 ×4）。星带时长 = 基准时长 ÷ 本值。 */
    var BASE_SPEEDUP = 4;
    /** 星点亮度/大小下限（1 = 上限）。 */
    var STARFIELD_MIN = 0.5;
    /**
     * 星带：每条是一层 200% 宽的容器，星星在 [2%,48%] 里铺，另有一份复制品在 +50% 处。
     * 容器从 translateX(0) 匀速走到 translateX(-50%)，左边的星星出画与右边的复制品入画
     * 严格接续 —— 所以星点是**匀速横移、不闪现、不闪烁**（实机实测：亮度恒定、无亮灭）。
     * 三条带周期互不成整数比（30/21/14），叠起来不会整齐地一起重来。
     */
    var STAR_LAYERS = [
      { count: 4, duration: 30 },
      { count: 4, duration: 21 },
      { count: 4, duration: 14 }
    ];
    /** 位置速率的上限（= speedFor 的封顶值），用来把"最快那一档"和基准时长对齐。 */
    var MAX_SPEED_FACTOR = 2;
    /** 系统开启「减少动态效果」时，星星时长乘这个倍数（放缓而不是冻住）。 */
    var REDUCED_MOTION_SLOWDOWN = 2.6;
    /**
     * 最高档判定阈值：`pctFromIndex(末档, n)` 恒等于 1，其余档位 ≤ 1 − 1/(n−1)。
     * 所以「pct ≥ 这个值」等价于「停在最高档」，与档位数无关。
     */
    var MAX_PCT = 0.999;

    /**
     * 普通档位填充色 = **#339CFF 纯色**（实机量取）。
     * 旧版按位置混蓝→紫→深紫，导致中间档位就带紫；实机里**只有最高档是紫的**，其余全蓝。
     */
    var COLOR_BLUE = [51, 156, 255];
    /**
     * 普通档位的**文字**蓝：比填充色 #339CFF 深一点点（#2E93F5）。
     * 填充用 #339CFF 忠于实机；但 #339CFF 当文字对白底只有 2.86:1，压线不过，
     * 所以文字单独深一档（3.2:1）—— 肉眼分不出来，对比度够了。
     */
    var COLOR_TEXT_BLUE = [46, 147, 245];
    /** 最高档文字紫（实机 #924FF7）：对白底 ≈3.4:1、对深色底 ≈5.6:1，两种主题都读得清。 */
    var COLOR_TEXT_VIOLET = [146, 79, 247];
    /** 最高档填充右端色（只用于需要单色的场合）。 */
    var COLOR_MAX_END = [92, 49, 198];
    /**
     * 最高档底色：实机录屏跨 8 个时刻（间隔 8s）逐列取**中位数**得到的渐变。
     * 左端是浅蓝紫 #7E90FA，35%~52% 最亮（#A594FD → #A87FFE），再往右收深到 #744AE7。
     * 底色本身不动；"颜色会变"是下面两层极光在慢慢游走造成的。
     */
    var MAX_FILL_GRADIENT = "linear-gradient(90deg,#7e90fa 0%,#8b8efc 12%,#9892fb 25%,#a594fd 35%,#ab8cfa 45%,#a87ffe 52%,#a674fd 60%,#9458fb 70%,#814eee 80%,#744ae7 90%,#764de9 100%)";
    /**
     * 极光（亮）：两块柔和的浅紫光斑。实机里"最亮的那一段"会在整条轨道上缓慢来回移动
     * （8 个时刻测到的亮区位置：25% → 0% → 75% → 30% → 45% → 50% → 50% → 55%），
     * 单帧静态渐变复现不了，所以用两层以不同周期摆动的光斑叠上去。
     * 必须用 `mix-blend-mode:screen`：用白色普通叠加会把紫冲成灰紫。
     */
    var AURORA_GLOW = "radial-gradient(32% 150% at 26% 50%,rgba(166,132,255,.34) 0%,rgba(166,132,255,.17) 40%,rgba(166,132,255,0) 74%),radial-gradient(26% 150% at 70% 50%,rgba(126,94,246,.26) 0%,rgba(126,94,246,.11) 46%,rgba(126,94,246,0) 78%)";
    /**
     * 极光（暗）：一块深紫阴影，和亮斑反相摆动 —— 实机里"最暗的那一段"也在移动
     * （85% → 65% → 40% → 80% → 85% → 90% → 90% → 60%）。没有它，轨道只会整体变亮变暗，
     * 不会有"颜色在流动"的观感。
     */
    var AURORA_SHADE = "radial-gradient(34% 160% at 50% 50%,rgba(38,14,86,.17) 0%,rgba(38,14,86,.08) 46%,rgba(38,14,86,0) 76%)";

    /* ════════════════════════════ 样式 ════════════════════════════ */

    /*
     * 颜色一律走 DSH 自己的设计令牌（`--dsw-*`），浅色/深色自动跟随。
     * 蓝色强调色用 `--dsw-alias-state-business-primary`（深色下 = deepseek-400 #7aaaff），
     * 回退到 blue-450 #4d93f8 —— 也就是参考图里那条轨道的蓝。
     */
    var CSS = [
      /* 注入进官方那一行的容器：折行到第二行并铺满整行 */
      ".ces-inline{--ces-accent:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#4d93f8));box-sizing:border-box;flex-basis:100%;width:100%;min-width:0}",
      ".ces-track{position:relative;box-sizing:border-box;height:" + TRACK_HEIGHT + "px;margin-top:2px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(15,17,21,.08));cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
      ".ces-track:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--ces-accent));outline-offset:2px}",
      ".ces-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;pointer-events:none}",
      ".ces-tick{position:absolute;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 26%,transparent);pointer-events:none}",
      ".ces-tick[data-on='1']{background:rgba(255,255,255,.5)}",
      /* 旋钮直径 = 轨道高度（"与滑条同宽"）：圆完整地填满管口，不会出现被裁出的平边。 */
      ".ces-knob{position:absolute;top:50%;width:" + KNOB_SIZE + "px;height:" + KNOB_SIZE + "px;margin:" + (-KNOB_RADIUS) + "px 0 0 " + (-KNOB_RADIUS) + "px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.05);pointer-events:none}",
      ".ces-error{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
      /* ── 最高档层（静止底色 + 缓慢游走的极光 + 匀速横移的星点）─────────────
         只有最高档才显示（data-energy 由档位驱动，0/1）。整层只做 opacity 淡入。 */
      ".ces-energy{position:absolute;top:0;bottom:0;left:0;border-radius:999px;overflow:hidden;pointer-events:none;isolation:isolate;opacity:var(--ces-energy,0);transition:opacity .2s ease;background:" + MAX_FILL_GRADIENT + "}",
      /* 极光（亮）：两块浅紫光斑，27s 来回摆一趟。screen 混合 —— 用白色普通叠加会发灰。 */
      ".ces-aurora{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;background:" + AURORA_GLOW + ";animation:ces-aurora-sway 27s ease-in-out infinite alternate;will-change:transform}",
      /* 极光（暗）：一块深紫阴影，41s 反相摆一趟。两个周期不成整数比 → 观感不重复。 */
      ".ces-shade{position:absolute;inset:0;pointer-events:none;background:" + AURORA_SHADE + ";animation:ces-shade-sway 41s ease-in-out infinite alternate;will-change:transform}",
      "@keyframes ces-aurora-sway{from{transform:translate3d(-9%,9%,0)}to{transform:translate3d(17%,-9%,0)}}",
      "@keyframes ces-shade-sway{from{transform:translate3d(15%,-8%,0)}to{transform:translate3d(-19%,8%,0)}}",
      /* 星点层：不跟紫层淡入（否则最高档也会被紫层透明度压暗）。 */
      ".ces-stars{position:absolute;top:0;bottom:0;left:0;border-radius:999px;overflow:hidden;pointer-events:none;transition:opacity .2s ease}",
      /* 星带：200% 宽，匀速左移半层宽。左侧星星出画与右侧复制品入画严格接续 → 无闪现。
         周期与负相位内联写在元素上（三条带各不相同）。 */
      ".ces-starfield{position:absolute;top:0;bottom:0;left:0;width:200%;pointer-events:none;animation-name:ces-star-drift;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}",
      "@keyframes ces-star-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}",
      ".ces-star{position:absolute;width:0;height:0;pointer-events:none}",
      /* 星点本体：2px 浅紫圆点，**亮度恒定**（没有任何 opacity/scale 动画）。
         实机量取：核心 #D19DFF，2×2 像素，外圈只有 1px 抗锯齿 —— 所以辉光要极小。 */
      ".ces-star__dot{position:absolute;left:0;top:0;width:var(--ces-s,3px);height:var(--ces-s,3px);margin:calc(var(--ces-s,3px) / -2) 0 0 calc(var(--ces-s,3px) / -2);border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(216,174,255,.97) 0%,rgba(210,166,255,.88) 40%,rgba(204,158,255,.42) 70%,rgba(200,152,255,0) 100%)}",
      "body[data-ds-dark-theme] .ces-star__dot{background:radial-gradient(circle at 50% 50%,rgba(224,190,255,.98) 0%,rgba(218,180,255,.9) 40%,rgba(210,170,255,.45) 70%,rgba(206,164,255,0) 100%)}",
      /* 系统要求「减少动态效果」时放缓横移（时长在 JS 里乘 REDUCED_MOTION_SLOWDOWN）。 */
      "@media (prefers-reduced-motion: reduce){.ces-energy{transition:none}}",
    ].join("\n");

    /** 把样式挂进文档。加载器会把它认领为「本插件产出的 style」（HMR 卸载时一并清理）。 */
    function installStyles() {
      try {
        if (typeof document === "undefined" || !document.head) return null;
        var existing = document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
        if (existing) return existing;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", STYLE_MARKER);
        style.textContent = CSS;
        document.head.appendChild(style);
        return style;
      } catch (error) {
        /* 样式失败只影响观感，绝不影响功能 */
        return null;
      }
    }

    /* ════════════════════════ 纯函数（可离线单测）════════════════════════ */

    var EMPTY_SNAPSHOT = Object.freeze({
      current: null,
      groups: [],
      failures: [],
      status: "idle",
      pending: null,
      error: null,
      retainedEffort: undefined,
    });

    /** 在目录快照里找到当前模型条目（groups[].models[]）。 */
    function modelOf(state) {
      var current = state && state.current;
      if (!current || typeof current.provider !== "string" || typeof current.model !== "string") return null;
      var groups = state && Array.isArray(state.groups) ? state.groups : [];
      for (var i = 0; i < groups.length; i += 1) {
        var group = groups[i];
        if (!group || group.id !== current.provider) continue;
        var models = Array.isArray(group.models) ? group.models : [];
        for (var j = 0; j < models.length; j += 1) {
          if (models[j] && models[j].id === current.model) return models[j];
        }
      }
      return null;
    }

    /** 当前模型真实可用的档位列表（官方 id + 官方显示名，按目录顺序）。 */
    function levelsOf(state) {
      var model = modelOf(state);
      var efforts = model && model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      var out = [];
      for (var i = 0; i < efforts.length; i += 1) {
        var effort = efforts[i];
        if (!effort || typeof effort.id !== "string" || effort.id.length === 0) continue;
        out.push({
          id: effort.id,
          name: typeof effort.name === "string" && effort.name.length > 0 ? effort.name : effort.id,
        });
      }
      return out;
    }

    /**
     * 当前**生效**的档位 id：显式设置优先；没设置过就是模型的默认档
     * （与官方 `syncInputs()` 的 `effort = intended.reasoningEffort ?? reasoning.defaultEffort` 同款）。
     */
    function effectiveEffortId(state) {
      var current = state && state.current;
      if (current && typeof current.reasoningEffort === "string" && current.reasoningEffort.length > 0) {
        return current.reasoningEffort;
      }
      var model = modelOf(state);
      var fallback = model && model.reasoning && model.reasoning.defaultEffort;
      return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
    }

    function indexOfLevel(levels, id) {
      if (typeof id !== "string") return -1;
      for (var i = 0; i < levels.length; i += 1) if (levels[i].id === id) return i;
      return -1;
    }

    function clamp01(value) {
      if (!(value > 0)) return 0; // 同时挡住 NaN
      return value > 1 ? 1 : value;
    }

    /** 百分比 → 最近档位下标（滑条连续，档位离散，所以必须吸附）。 */
    function indexFromPct(pct, count) {
      if (count <= 1) return 0;
      return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
    }

    /** 档位下标 → 该档位在轨道上的百分比（刻度点与旋钮永远对齐）。 */
    function pctFromIndex(index, count) {
      if (count <= 1) return 0;
      var safe = Math.max(0, Math.min(count - 1, index));
      return safe / (count - 1);
    }

    function errorText(error) {
      if (error === null || error === undefined) return "档位切换失败";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message.length > 0) return error.message;
      if (typeof error.code === "string" && error.code.length > 0) return error.code;
      return String(error);
    }

    /* ─────────────────── 最高档能量层：参数与强度曲线 ─────────────────── */

    /**
     * 星点：**全部由下标算出，不用随机数** —— 每次渲染完全一致、可离线断言。
     *
     * 形态 = 2px 浅紫圆点（实机量取：核心 #D19DFF、2×2 像素、外圈只有 1px 抗锯齿边，
     * **不是纯白也没有大范围辉光**）。
     * 运动 = 三层星带各自匀速左移；**亮度恒定**，没有任何淡入淡出/缩放
     * （用户实测反馈："星点是在移动的，没有光的强度的亮灭"）。
     *
     * 横坐标铺在 [2%,48%]（星带容器宽 200%，复制品在 +50% 处），
     * 高度铺在 [12%,88%]，尺寸 1.7~2.4px。
     */
    var PARTICLES = (function buildParticles() {
      var out = [];
      var index = 0;
      for (var l = 0; l < STAR_LAYERS.length; l += 1) {
        var layer = STAR_LAYERS[l];
        for (var i = 0; i < layer.count; i += 1) {
          out.push({
            x: 2 + starHash01(index, 97) * 46,
            y: 12 + starHash01(index, 53) * 76,
            size: 2.2 + starHash01(index, 29) * 0.5,
            layer: l,
            duration: layer.duration,
            delay: -(layer.duration * (0.13 + 0.21 * l))
          });
          index += 1;
        }
      }
      return out;
    })();

    /* 颜色常量与 ENERGY_* 都声明在文件上部的「尺寸与速率常量」块里（供 CSS 插值用），
       这里只放纯函数 —— 不要再重复声明，否则会出现"改一处漏一处"的双份真相。 */

    function mixColor(from, to, t) {
      var k = clamp01(t);
      return [
        Math.round(from[0] + (to[0] - from[0]) * k),
        Math.round(from[1] + (to[1] - from[1]) * k),
        Math.round(from[2] + (to[2] - from[2]) * k),
      ];
    }

    function rgbOf(color) {
      return "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
    }

    /** 位置 → 是否停在最高档。**只有最高档才用紫色**（实机如此，与档位数无关）。 */
    function isMaxPct(pct) {
      return clamp01(pct) >= MAX_PCT;
    }

    /** 位置 → 填充色：非最高档恒为 #339CFF 纯蓝，最高档是紫色。 */
    function fillColorFor(pct) {
      return isMaxPct(pct) ? rgbOf(COLOR_MAX_END) : rgbOf(COLOR_BLUE);
    }

    /**
     * 位置 → 填充层背景。
     * 非最高档是**纯色**（不再按位置混紫）；最高档是静止的紫罗兰渐变。
     */
    function fillBackgroundFor(pct) {
      return isMaxPct(pct) ? MAX_FILL_GRADIENT : rgbOf(COLOR_BLUE);
    }

    /**
     * 位置 → **官方那一行数值文字**（"Max"）的颜色。
     *
     * 与能量同源：蓝 → 紫罗兰，越往右越紫（用户要求"Max 的字体颜色能不能改变"）。
     * 刻意**不跟填充末尾的深紫走** —— `COLOR_DEEP` 当文字在深色底上几乎看不见；
     * 文字需要一个亮端，所以终点用 `COLOR_TEXT_VIOLET`。
     *
     * **Off 档返回空串**：不写内联色 = 官方原本的灰（用户要求"off 档两个界面都是灰的"）。
     * 调用方直接 `style.color = valueColorFor(...)`，空串在浏览器里就是"清掉内联色"。
     */
    function valueColorFor(pct, level) {
      if (isOffLevel(level)) return "";
      return isMaxPct(pct) ? rgbOf(COLOR_TEXT_VIOLET) : rgbOf(COLOR_TEXT_BLUE);
    }

    /**
     * 是不是"关闭推理"那一档。
     *
     * DeepSeek 的档位表是 id `off` / name `Off`（见 `dsh-llm-deepseek/lib/index.js` 的
     * `REASONING_EFFORTS`），但 id 是 provider 自己的字符串，所以 id 和 name 都认一遍，
     * 并额外接受几个同义写法。认不出就是普通档位（照常着色）。
     */
    function isOffLevel(level) {
      if (!level) return false;
      var candidates = [level.id, level.name];
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] !== "string") continue;
        var flat = candidates[i].replace(/\s+/g, "").toLowerCase();
        if (flat === "off" || flat === "none" || flat === "关闭" || flat === "无") return true;
      }
      return false;
    }

    /**
     * 位置 → 能量强度 0..1（紫色星云 + 粒子的总强度）。
     * **纯位置驱动，与档位数无关**：第二档以前为 0（保持干净的蓝），之后线性渐入到最高档的 1。
     * 锚点：pct=1/3 → 0；pct=2/3（4 档模型的 high）→ 0.5；pct=1（max）→ 1。
     */
    function energyFor(pct) {
      return isMaxPct(pct) ? 1 : 0;
    }

    /**
     * 位置 → 粒子速率倍数。
     * 锚点来自实测反馈：**high 档（4 档模型的 2/3 处）= 1×（也就是现在这个速度刚刚好）**，
     * 最高档 = 2×。再往左按同一斜率降速，但设 0.35× 下限，免得左端变成静止。
     */
    function speedFor(pct) {
      return Math.min(2, Math.max(0.35, 3 * clamp01(pct) - 1));
    }

    /** 位置 → 可见粒子数（"粒子效果逐渐出现、变密集"）。 */
    function particleCountFor(pct) {
      return Math.round(energyFor(pct) * PARTICLES.length);
    }

    /* ── 星空：所有出现粒子的档位都用这一套（统一的动画）────────────────────

       运动模型：外层是一条**整轨宽度**的轨道，自己在做 `translate3d(-100%)` 的连续横穿；
       圆点在最右端出生、向左穿出，残影只在两端淡出（而那两端在可视区外）→ **从不消失**。
       每颗的亮度/大小由确定性伪随机给出（越亮越大，0.5~1），速率随**位置**变化（速度变化保留）。 */

    /** 确定性伪随机 [0,1)：不用 Math.random（可离线断言、重渲染不跳变），但看起来是随机的。 */
    function starHash01(index, salt) {
      var value = (index + 1) * salt * 2654435761 % 4294967296;
      return ((value >>> 8) % 1000) / 1000;
    }

    /** 第 index 颗粒子的亮度/大小系数，落在 [STARFIELD_MIN, 1]（越亮越大）。 */
    function starBrightnessFor(index) {
      return STARFIELD_MIN + (1 - STARFIELD_MIN) * starHash01(index, 61);
    }

    /**
     * 第 index 颗星所在星带的横移周期（s）。
     * 三条带 30 / 21 / 14 秒走完半层宽度，互不成整数比 → 叠起来不会整齐地一起重来。
     */
    function starDriftDurationFor(index) {
      var particle = PARTICLES[index];
      return particle && typeof particle.duration === "number" ? particle.duration : 27;
    }

    /** 第 index 颗星所在星带的相位（负延迟，s）—— 三条带错开，不会同时从同一点起步。 */
    function starDriftDelayFor(index) {
      var particle = PARTICLES[index];
      return particle && typeof particle.delay === "number" ? particle.delay : 0;
    }

    /** 第 index 颗星的直径（px）。实机 2×2 像素核心，1.7~2.4px 之间浮动。 */
    function starSizeFor(index) {
      var particle = PARTICLES[index];
      return particle && typeof particle.size === "number" ? particle.size : 2;
    }

    /** 第 layerIndex 条星带的周期（s），供容器元素的 animation-duration 用。 */
    function starLayerDurationFor(layerIndex) {
      var layer = STAR_LAYERS[layerIndex];
      return layer && typeof layer.duration === "number" ? layer.duration : 27;
    }

    /** 第 layerIndex 条星带的相位（负延迟，s）。 */
    function starLayerDelayFor(layerIndex) {
      var layer = STAR_LAYERS[layerIndex];
      if (!layer) return 0;
      return -(layer.duration * (0.13 + 0.21 * layerIndex));
    }

    /** 位置 → 可见星星数（"逐渐出现、变密集"）。 */
    function starCountFor(pct) {
      return particleCountFor(pct);
    }

    /**
     * 位置 → **星星层**的不透明度。
     *
     * 星星不能跟着星云一起淡入：星云层的透明度 = 能量强度，high 档只有 0.5，
     * 那么每颗星的实际不透明度会被压到 0.25~0.5，在紫色底上几乎看不见
     * （用户实测反馈："high 档一打开几乎没粒子"）。所以星星层单独给一个下限，
     * 只随能量轻微变化：high 档 0.8、MAX 档 1.0 —— "逐渐出现"交给**粒子数**去表达。
     */
    function starLayerOpacityFor(pct) {
      return energyFor(pct);
    }

    /**
     * 旋钮中心 / 填充终点 / 刻度的水平位置：`半径 + pct × (100% − 直径)`。
     * 这样 pct=0 时圆心正好落在左端圆角内、pct=1 时落在右端圆角内 —— 圆圈永远是完整的圆。
     */
    /**
     * 填充层的宽度：**旋钮圆心 + 半径 − 2px**。
     *
     * 只画到圆心时，填充右端的圆弧（半径 = 半个轨道高）与旋钮（半径更大、圆心在更右）
     * 不同心，右上/右下角会露出一块缺口；画到旋钮右缘又会在圆心那一行正好相切，
     * 抗锯齿留下一条紫色细边。内收 2px 后填充在整个高度上都稳稳落在旋钮轮廓之内。
     */
    function fillWidthOf(pct) {
      var t = Math.round(clamp01(pct) * 10000) / 10000;
      return "calc(" + (KNOB_SIZE - 2) + "px + " + t + " * (100% - " + KNOB_SIZE + "px))";
    }

    function knobOffsetOf(pct) {
      var t = Math.round(clamp01(pct) * 10000) / 10000;
      return "calc(" + KNOB_RADIUS + "px + " + t + " * (100% - " + KNOB_RADIUS * 2 + "px))";
    }

    /* ═════════════════ 官方目录访问（每会话一个，永不抛错）═════════════════ */

    /**
     * 每个会话一个访问器。它解决两件真实存在的事：
     *  1. `directoryFor(sessionId)` 在会话作用域/绑定尚未就绪时**按设计抛错**；
     *  2. 目录实例可能被重建（换模型代、连接重置），"抓一次揣着用"会变成永久坏的控件。
     * 所以每次读写都重新解析，解析失败就退避重试；订阅在一次成功解析后建立。
     */
    function createDirectoryAccess(ctx, sessionId, timers) {
      var listeners = new Set();
      var directory = null;
      var unsubscribe = null;
      var last = EMPTY_SNAPSHOT;
      var retryIndex = 0;
      var retryTimer = null;
      var closed = false;
      var lastLoadAt = 0;

      function notify() {
        var current = [];
        listeners.forEach(function (listener) { current.push(listener); });
        for (var i = 0; i < current.length; i += 1) {
          try { current[i](); } catch (error) { /* 单个订阅者抛错不影响其它订阅者 */ }
        }
      }

      function scheduleRetry() {
        if (closed || retryTimer !== null || retryIndex >= RETRY_DELAYS.length) return;
        var delay = RETRY_DELAYS[retryIndex];
        retryIndex += 1;
        retryTimer = timers.set(function () {
          retryTimer = null;
          // 解析成功后要主动通知一次：调用方（uSES）正等着 store 出现。
          if (resolve() !== null) {
            notify();
            return;
          }
          // 还没就绪就继续退避 —— 少了这一句，第一次重试失败后自愈链就永久断掉，
          // 控件会静默失效（这正是要防的那种"一次启动期抖动变成永久坏控件"）。
          scheduleRetry();
        }, delay);
      }

      /** 重新解析一次目录；实例变化时重挂订阅。返回当前目录（可能为 null）。 */
      function resolve() {
        if (closed) return null;
        var fresh = null;
        try {
          fresh = ctx.modelDirectories.directoryFor(sessionId);
        } catch (error) {
          fresh = null;
        }
        if (!fresh || !fresh.store || typeof fresh.store.getSnapshot !== "function") fresh = null;
        if (fresh === directory) return directory;
        if (unsubscribe !== null) {
          try { unsubscribe(); } catch (error) { /* 退订失败不影响新订阅 */ }
          unsubscribe = null;
        }
        directory = fresh;
        if (directory !== null) {
          retryIndex = 0;
          try {
            unsubscribe = typeof directory.store.subscribe === "function" ? directory.store.subscribe(notify) : null;
          } catch (error) {
            unsubscribe = null;
          }
          kickLoad();
        }
        return directory;
      }

      /** 主动拉一次目录（不 load 的话 store 停在 idle，档位列表是空的）。 */
      function kickLoad() {
        if (closed || directory === null || typeof directory.load !== "function") return;
        var now = Date.now();
        if (now - lastLoadAt < 400) return;
        lastLoadAt = now;
        var target = directory;
        try {
          Promise.resolve(target.load()).catch(function () { /* 失败原因由 store 的 error 字段呈现 */ });
        } catch (error) {
          /* load 同步抛：同样交给 store 状态 */
        }
      }

      return {
        getSnapshot: function () {
          if (closed) return EMPTY_SNAPSHOT;
          if (directory === null) {
            resolve();
            if (directory === null) scheduleRetry();
          }
          if (directory !== null) {
            try {
              var value = directory.store.getSnapshot();
              if (value && typeof value === "object") last = value;
            } catch (error) {
              /* 保留上一次快照，绝不把渲染打崩 */
            }
          }
          return last;
        },
        subscribe: function (listener) {
          if (closed) return function () {};
          listeners.add(listener);
          if (directory === null) {
            resolve();
            if (directory === null) scheduleRetry();
          }
          // StrictMode 会订阅/退订各跑一次；退订只清订阅，不永久关闭访问器。
          return function () {
            listeners.delete(listener);
          };
        },
        /** 取当前真正可写的目录（load/select 在调用时重新解析，避免用失效实例）。 */
        directory: function () {
          var fresh = resolve();
          return fresh !== null ? fresh : directory;
        },
        load: kickLoad,
        dispose: function () {
          closed = true;
          listeners.clear();
          if (retryTimer !== null) {
            try { timers.clear(retryTimer); } catch (error) { /* 忽略 */ }
            retryTimer = null;
          }
          if (unsubscribe !== null) {
            try { unsubscribe(); } catch (error) { /* 忽略 */ }
            unsubscribe = null;
          }
          directory = null;
        },
      };
    }

    /* ══════════ 官方菜单那一行的 DOM 桥（只动那一行，fail-open）══════════ */

    function firstSpanText(row) {
      try {
        var spans = row.querySelectorAll("span");
        for (var i = 0; i < spans.length; i += 1) {
          var text = spans[i].textContent;
          if (typeof text === "string" && text.length > 0) return text;
        }
      } catch (error) {
        /* 认不出就算了，调用方会退到结构判定 */
      }
      return "";
    }

    /**
     * 官方那一行右侧的**数值文字**（"Max" / "High"）—— 就是 `.cellValue` 那个 span。
     * 找不到 class 时退到结构：行内最后一个非空文字的 span（数值在标签之后、箭头之前）。
     * 只改它的颜色，文字内容一律不碰。
     */
    function findValueElement(row) {
      if (!row || typeof row.querySelectorAll !== "function") return null;
      try {
        var byClass = row.querySelectorAll("span[class*='cellValue']");
        if (byClass.length > 0) return byClass[byClass.length - 1];
        var spans = row.querySelectorAll("span");
        var found = null;
        for (var i = 0; i < spans.length; i += 1) {
          var text = spans[i].textContent;
          if (typeof text === "string" && text.replace(/\s+/g, "").length > 0) found = spans[i];
        }
        return found;
      } catch (error) {
        return null;
      }
    }

    /**
     * **收起的模型席按钮**（"DeepSeek-V41-Flash  High  ⌄"）里只显示档位名的那一小段文字。
     *
     * 官方渲染它用的是哈希 class（`wq12jW_triggerEffort`，前缀随构建变），靠 class 认迟早会失效，
     * 所以按**文字**认：官方 trigger 里的档位文字就是档位的 `name`，和我们从目录读到的是同一份数据。
     *
     * 传**全部档位名**（而不是只要当前那个）：档位刚切换、官方还没重渲染席按钮时，
     * 文字还是旧档位名 —— 只认当前名字会在那一瞬间"放手"，颜色闪一下。
     * 认不出任何已知档位名就返回 null（fail-open，绝不动别的文字）。
     */
    function findSeatEffort(doc, composer, expectedLabels) {
      if (!doc || !composer || typeof doc.querySelectorAll !== "function") return null;
      var list = typeof expectedLabels === "string" ? [expectedLabels] : expectedLabels;
      if (Object.prototype.toString.call(list) !== "[object Array]") return null;
      var wanted = [];
      for (var n = 0; n < list.length; n += 1) {
        var name = typeof list[n] === "string" ? list[n].replace(/\s+/g, "") : "";
        if (name.length > 0 && wanted.indexOf(name) < 0) wanted.push(name);
      }
      if (wanted.length === 0) return null;
      try {
        var seats = doc.querySelectorAll('button[aria-haspopup="menu"]');
        for (var i = 0; i < seats.length; i += 1) {
          if (!composer.contains(seats[i])) continue;
          var spans = seats[i].querySelectorAll("span");
          for (var j = 0; j < spans.length; j += 1) {
            var text = spans[j].textContent;
            if (typeof text === "string" && wanted.indexOf(text.replace(/\s+/g, "")) >= 0) return spans[j];
          }
        }
      } catch (error) {
        return null;
      }
      return null;
    }

    /**
     * 在自己所属的 composer 里，找到"打开的那颗官方模型席"对应的菜单，再找到推理等级那一行。
     * 全部用官方**语义属性**（aria-haspopup / aria-expanded / aria-controls / role）定位，
     * 不依赖哈希 class —— 官方改样式不会影响这里，改语义才会（那种改动会先在我的测试里炸掉）。
     */
    function findEffortRow(doc, composer) {
      if (!doc || !composer || typeof doc.querySelectorAll !== "function") return null;
      var seats = doc.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]');
      var seat = null;
      for (var i = 0; i < seats.length; i += 1) {
        if (composer.contains(seats[i])) { seat = seats[i]; break; }
      }
      if (seat === null) return null;

      var menuId = typeof seat.getAttribute === "function" ? seat.getAttribute("aria-controls") : null;
      var menu = menuId && typeof doc.getElementById === "function" ? doc.getElementById(menuId) : null;
      if (!menu) return null;

      var items = menu.querySelectorAll('button[role="menuitem"]');
      if (items.length !== 2) return null; // 根面板恰好两行；子面板用的是 menuitemradio
      for (var j = 0; j < items.length; j += 1) {
        var label = firstSpanText(items[j]);
        for (var k = 0; k < EFFORT_ROW_LABELS.length; k += 1) {
          if (label === EFFORT_ROW_LABELS[k]) return items[j];
        }
      }
      // 文案认不出（官方改了措辞/别的语言）就按官方固定顺序：第 2 个 menuitem 是推理等级。
      return items[1];
    }

    /**
     * 监听文档，把滑条容器挂进官方那一行。
     *
     * @param options.doc      宿主 document
     * @param options.win       宿主 window（派发 resize 让官方重测菜单位置）
     * @param options.anchor    () => 本会话在 composer 里的锚点元素（用来判定"哪颗席是我的"）
     * @param options.active    () => boolean，当前是否值得注入（没有档位就不注入，免得白加高）
     * @param options.onChange  (host | null) => void
     */
    function createMenuBridge(options) {
      var doc = options.doc;
      var win = options.win;
      var anchor = options.anchor;
      var active = options.active;
      var onChange = options.onChange;
      if (!doc || typeof doc.createElement !== "function") return null;

      var current = null;
      var seat = null; // 收起态那一行里的档位文字（菜单没打开时也要着色）
      var seatColor = ""; // 组件给的当前颜色：重新抓到元素时立刻补上，不必等下一次渲染
      var observer = null;
      var timer = null;
      var disposed = false;
      var seatLabels = options.seatLabels; // () => string[]，全部已知档位名

      /** 本会话的 composer 容器：从锚点往上找官方给 composer 卡片打的标记。 */
      function composerOf() {
        var node = anchor();
        if (!node) return null;
        var el = node;
        while (el && el.nodeType === 1) {
          if (typeof el.getAttribute === "function" && el.getAttribute("data-composer-card") !== null) return el;
          el = el.parentNode;
        }
        return null;
      }

      function detach() {
        if (current === null) return;
        var row = current.row;
        var container = current.container;
        try {
          if (container && container.parentNode) container.parentNode.removeChild(container);
        } catch (error) { /* 行可能已经被官方卸载 */ }
        try {
          var previous = current.previous;
          if (row && row.style) {
            row.style.height = previous.height;
            row.style.flexWrap = previous.flexWrap;
            row.style.paddingTop = previous.paddingTop;
            row.style.paddingBottom = previous.paddingBottom;
            row.style.boxShadow = previous.boxShadow;
          }
          // 数值文字（"Max"）的颜色也是我们改的，退出时一并还原
          if (current.value && current.value.style) current.value.style.color = previous.valueColor;
        } catch (error) { /* 还原失败不影响官方菜单自身 */ }
        current = null;
        onChange(null);
      }

      /** 收起的档位文字：还原本来的颜色并忘掉它。 */
      function releaseSeat() {
        if (seat === null) return;
        try {
          if (seat.el && seat.el.style) seat.el.style.color = seat.previousColor;
        } catch (error) { /* 元素可能已被官方卸载 */ }
        seat = null;
      }

      /**
       * 同步收起态的档位文字。
       * 只在**元素换了**（官方重渲染换了节点）或还没抓到时重新抓 —— 文字变了不换元素，
       * 所以档位切换不会造成"还原→再上色"的闪动。
       */
      function syncSeat() {
        var composer = composerOf();
        if (composer === null || active() !== true) { releaseSeat(); return; }
        if (seat !== null && seat.el && doc.documentElement && doc.documentElement.contains(seat.el)) {
          if (seatColor && seat.el.style) seat.el.style.color = seatColor; // 官方清过内联样式就补回来
          return;
        }
        releaseSeat();
        var wanted = typeof seatLabels === "function" ? seatLabels() : null;
        var el = findSeatEffort(doc, composer, wanted);
        if (el === null || !el.style) return;
        seat = { el: el, previousColor: el.style.color || "" };
        if (seatColor) el.style.color = seatColor;
      }

      function scan() {
        if (disposed) return;
        // 收起态的档位文字：跟菜单那一行互相独立，任一处失败都不该拖垮另一处
        try { syncSeat(); } catch (error) { /* 忽略 */ }
        try {
          var composer = composerOf();
          if (composer === null || active() !== true) { detach(); return; }
          // 已经挂好且那一行还在 → 什么都不做
          if (current !== null && current.row && doc.documentElement && doc.documentElement.contains(current.row)) return;

          var row = findEffortRow(doc, composer);
          if (row === null) { detach(); return; }
          detach();

          var value = findValueElement(row);
          var previous = {
            // 真实 DOM 里未设置的内联属性读作 ""，这里统一成同样的语义，还原时才不会写回
            // 字面量 "undefined"（那在浏览器里是无效值，会把我们的加高留在原地）。
            height: row.style.height || "",
            flexWrap: row.style.flexWrap || "",
            paddingTop: row.style.paddingTop || "",
            paddingBottom: row.style.paddingBottom || "",
            boxShadow: row.style.boxShadow || "",
            // 数值文字原来的内联颜色（通常没设过，读作 ""）
            valueColor: value && value.style ? value.style.color || "" : "",
          };
          // 「加高那一栏的上下距离」+ 允许折行，让滑条落到第二行并铺满整行宽度。
          row.style.height = "auto";
          row.style.flexWrap = "wrap";
          row.style.paddingTop = ROW_PADDING_BLOCK;
          row.style.paddingBottom = ROW_PADDING_BLOCK;

          var container = doc.createElement("div");
          container.className = "ces-inline";
          container.setAttribute("data-ces-part", "host");
          row.appendChild(container);

          current = { row: row, container: container, value: value, previous: previous };
          onChange(current);

          // 官方菜单是"测量后固定定位"的，加高后让它重测一次（官方自己在 resize 里重测并夹取）。
          try {
            win.dispatchEvent(new win.Event("resize"));
          } catch (error) { /* 宿主没有 Event 构造器就算了，官方也会在状态变化时重测 */ }
        } catch (error) {
          try { detach(); } catch (inner) { /* 兜到底 */ }
        }
      }

      function start() {
        scan();
        var MO = win && (win.MutationObserver || (typeof MutationObserver === "function" ? MutationObserver : null));
        if (typeof MO === "function") {
          try {
            observer = new MO(function () { scan(); });
            observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
            return;
          } catch (error) {
            observer = null;
          }
        }
        // 没有 MutationObserver 时退化成低频轮询；反正每轮都很便宜。
        if (win && typeof win.setInterval === "function") timer = win.setInterval(scan, 400);
      }

      return {
        scan: scan,
        start: start,
        /** 组件把当前该用的颜色给进来；桥负责在（重新）抓到元素时立刻应用。 */
        setSeatColor: function (color) {
          seatColor = typeof color === "string" ? color : "";
          if (seat !== null && seat.el && seat.el.style) {
            try { seat.el.style.color = seatColor; } catch (error) { /* 忽略 */ }
          }
        },
        dispose: function () {
          disposed = true;
          if (observer !== null) {
            try { observer.disconnect(); } catch (error) { /* 忽略 */ }
            observer = null;
          }
          if (timer !== null) {
            try { win.clearInterval(timer); } catch (error) { /* 忽略 */ }
            timer = null;
          }
          releaseSeat();
          detach();
        },
        host: function () { return current; },
      };
    }

    /* ════════════════════════════ 组件 ════════════════════════════ */

    /**
     * 单组件设计：锚点 + 桥 + 滑条（portal 进官方那一行）都在同一个函数里，
     * 所有 hook 都在同一个实例上，展开/收起不会改变 hook 顺序。
     */
    function CodexEffortSlider(props) {
      var sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : null;
      var locked = props.locked === true;
      var ctx = props.__ctx;

      /** 系统的「减少动态效果」只影响**特效强度**，不影响功能（放缓而不是冻住）。 */
      var reducedMotion = false;
      try {
        reducedMotion = typeof window !== "undefined"
          && typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch (error) {
        reducedMotion = false;
      }

      var access = React.useMemo(
        function () {
          if (sessionId === null || !ctx) return null;
          return createDirectoryAccess(ctx, sessionId, {
            set: function (fn, delay) { return setTimeout(fn, delay); },
            clear: function (handle) { clearTimeout(handle); },
          });
        },
        [ctx, sessionId],
      );

      React.useEffect(function () {
        return function () {
          if (access !== null) access.dispose();
        };
      }, [access]);

      var subscribe = React.useCallback(
        function (onChange) { return access === null ? function () {} : access.subscribe(onChange); },
        [access],
      );
      var getSnapshot = React.useCallback(
        function () { return access === null ? EMPTY_SNAPSHOT : access.getSnapshot(); },
        [access],
      );
      var state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      var levels = levelsOf(state);
      var effectiveId = effectiveEffortId(state);
      var committedIndex = indexOfLevel(levels, effectiveId);
      var levelCount = levels.length;

      var draftState = React.useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var optimisticState = React.useState(null);
      var optimistic = optimisticState[0];
      var setOptimistic = optimisticState[1];
      var errorState = React.useState(null);
      var errorText_ = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var hostState = React.useState(null);
      var host = hostState[0];
      var setHost = hostState[1];

      var anchorRef = React.useRef(null);
      var trackRef = React.useRef(null);
      var optimisticIdRef = React.useRef(null);
      /** 拖动的"最新位置"放 ref：React 会把同一 tick 的多次 setState 合并，
       *  松手那一帧若从 state 读位置，可能读到上一次渲染的旧值，从而写错档位。 */
      var draftRef = React.useRef(null);
      var commitRef = React.useRef({ timer: null, inFlight: false, queued: null });
      var draggingRef = React.useRef(false);
      var levelCountRef = React.useRef(0);
      var seatNamesRef = React.useRef([]); // 全部已知档位名（认官方席按钮上的那段文字用）
      var bridgeRef = React.useRef(null);
      levelCountRef.current = levelCount;

      /* 桥：找到官方菜单那一行，把滑条容器挂进去 */
      React.useEffect(function () {
        if (sessionId === null || !ctx) return undefined;
        var bridge = createMenuBridge({
          doc: typeof document === "undefined" ? null : document,
          win: typeof window === "undefined" ? null : window,
          anchor: function () { return anchorRef.current; },
          active: function () { return levelCountRef.current > 0; },
          onChange: function (next) { setHost(next); },
          // 收起态那一行显示的档位名（官方 trigger 里的文字就是它）；给全部名字更抗"官方还没重渲染"
          seatLabels: function () { return seatNamesRef.current; },
        });
        if (bridge === null) return undefined;
        bridgeRef.current = bridge;
        bridge.start();
        return function () {
          bridgeRef.current = null;
          bridge.dispose();
        };
      }, [ctx, sessionId]);

      /**
       * 档位是**后到**的（目录 load 完才有 efforts）。那时 DOM 没有任何变化，
       * MutationObserver 不会响，所以这里在档位数变化时主动重扫一次 ——
       * 少了这一句，"目录晚到"会让滑条永远挂不上去（起步期抖动变永久失效）。
       */
      React.useEffect(function () {
        if (bridgeRef.current !== null) bridgeRef.current.scan();
      }, [levelCount]);

      // 乐观值：提交后先按用户选的那一档显示，直到宿主真实回报（或超时回滚）。
      var optimisticId = optimistic !== null && typeof optimistic.id === "string" ? optimistic.id : null;
      var optimisticIndex = optimisticId === null ? -1 : indexOfLevel(levels, optimisticId);

      // **已生效**的档位（乐观值优先，其次真实值）：收起态那一行显示的是它，不是拖动中的草稿。
      var effectiveIndex = committedIndex >= 0 ? committedIndex : 0;
      if (optimisticIndex >= 0) effectiveIndex = optimisticIndex;
      var effectivePct = pctFromIndex(effectiveIndex, levelCount);
      var effectiveLevel = levels[effectiveIndex] || null;
      // 席按钮上可能出现的是**任意一个档位名**（档位刚切换时官方还没重渲染）
      var seatNames = [];
      for (var n = 0; n < levels.length; n += 1) {
        if (levels[n] && typeof levels[n].name === "string" && levels[n].name.length > 0) seatNames.push(levels[n].name);
      }
      seatNamesRef.current = seatNames;

      // 显示用的档位：拖动中跟着草稿，否则就是已生效那一档。
      var shownIndex = draft !== null ? draft.index : effectiveIndex;
      var shownPct = draft !== null && typeof draft.pct === "number" ? draft.pct : effectivePct;
      var shownLevel = levels[shownIndex] || null;

      // 三个由**位置**连续驱动的量：填充色（蓝→紫→深紫）、能量强度（星云+星星渐入）、位置速率。
      var energy = energyFor(shownPct);
      var energyOn = energy > 0;
      var fillBackground = fillBackgroundFor(shownPct);
      var knobOffset = knobOffsetOf(shownPct);
      var fillWidth = fillWidthOf(shownPct);

      // 官方那一行在最高档时描一圈紫边，强度跟着能量走（写内联样式，退出时由桥还原）。
      React.useEffect(function () {
        if (host === null || !host.row || !host.row.style) return;
        host.row.style.boxShadow = energyOn
          ? "inset 0 0 0 1px rgba(168,85,247," + (0.16 + 0.34 * energy).toFixed(2) + ")"
          : "";
      }, [host, energyOn, energy]);

      // 官方那一行的**数值文字**（"Max"）也跟着位置变色：蓝 → 亮紫（用户要求）。
      // 同样写内联、退出时由桥还原；**只改颜色，文字内容一个字都不碰**。
      React.useEffect(function () {
        if (host === null || !host.value || !host.value.style) return;
        host.value.style.color = valueColorFor(shownPct, shownLevel);
      }, [host, shownPct, shownLevel]);

      // **收起态**那一行的档位文字（模型席按钮上的 "High"，菜单没打开时就看得见）也跟着变色。
      // 颜色交给桥保管：官方重渲染换了节点时，桥会在重新抓到的那一刻补上，不必等 React。
      // 注意这里用**已生效**的档位（不是拖动中的草稿）—— 收起态显示的是真实档位。
      React.useEffect(function () {
        if (bridgeRef.current === null) return;
        bridgeRef.current.setSeatColor(valueColorFor(effectivePct, effectiveLevel));
      }, [levelCount, effectivePct, effectiveLevel]);

      // 宿主追上乐观值 → 撤掉乐观态（此后以真实目录为准）。
      React.useEffect(function () {
        if (optimisticId !== null && effectiveId === optimisticId) setOptimistic(null);
      }, [effectiveId, optimisticId]);

      // 超时兜底：宿主迟迟不回报就回滚并说明，不继续假装已生效。
      React.useEffect(function () {
        if (optimisticId === null) return undefined;
        var handle = setTimeout(function () {
          if (optimisticIdRef.current === optimisticId) {
            optimisticIdRef.current = null;
            setOptimistic(null);
            setError("档位切换超时，宿主未回报结果（已回滚显示）");
          }
        }, COMMIT_DEADLINE_MS);
        return function () { clearTimeout(handle); };
      }, [optimisticId]);

      // 组件卸载：清掉降频定时器（否则会在卸载后写一次宿主）。
      React.useEffect(function () {
        return function () {
          var pending = commitRef.current;
          if (pending.timer !== null) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
          pending.queued = null;
        };
      }, []);

      function currentState() {
        return access === null ? EMPTY_SNAPSHOT : access.getSnapshot();
      }

      function flush() {
        var pending = commitRef.current;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        var levelId = pending.queued;
        pending.queued = null;
        if (levelId === null || levelId === undefined || access === null) return;

        var snapshot = currentState();
        var current = snapshot && snapshot.current;
        if (!current || typeof current.provider !== "string" || typeof current.model !== "string") {
          setError("模型目录尚未就绪，无法写入档位");
          return;
        }
        // 发送前再判一次：可能宿主已经把这个档位写好了（去重的第二道闸）。
        if (effectiveEffortId(snapshot) === levelId) return;

        var directory = access.directory();
        if (directory === null || typeof directory.select !== "function") {
          setError("模型目录不可用，档位未写入");
          return;
        }

        pending.inFlight = true;
        optimisticIdRef.current = levelId;
        setOptimistic({ id: levelId });
        setError(null);
        setBusy(true);

        var result;
        try {
          result = directory.select({
            provider: current.provider,
            model: current.model,
            reasoningEffort: levelId,
          });
        } catch (error) {
          result = Promise.reject(error);
        }

        Promise.resolve(result).then(
          function (outcome) {
            pending.inFlight = false;
            if (outcome && outcome.ok === false) {
              optimisticIdRef.current = null;
              setOptimistic(null);
              setError(errorText(outcome.error));
            }
          },
          function (error) {
            pending.inFlight = false;
            optimisticIdRef.current = null;
            setOptimistic(null);
            setError(errorText(error));
          },
        ).then(function () {
          setBusy(false);
          // 在途合并：拖动期间攒下的最新值在这里补发。
          if (pending.queued !== null) flush();
        });
      }

      /** 请求写回某一档：同档位去重 + 在途合并 + 降频；immediate 用于松手/键盘。 */
      function requestCommit(levelId, immediate) {
        if (levelId === null || levelId === undefined) return;
        var pending = commitRef.current;
        var snapshot = currentState();
        if (effectiveEffortId(snapshot) === levelId && pending.queued === null && !pending.inFlight) return;
        pending.queued = levelId;
        if (pending.inFlight) return;
        if (immediate === true) {
          flush();
          return;
        }
        if (pending.timer !== null) return;
        pending.timer = setTimeout(function () {
          pending.timer = null;
          flush();
        }, COMMIT_THROTTLE_MS);
      }

      function pctAt(clientX) {
        var track = trackRef.current;
        if (!track || typeof track.getBoundingClientRect !== "function") return null;
        var rect = track.getBoundingClientRect();
        // 与视觉几何一致：指针落点映射到"旋钮圆心能到的那一段"，所以拖到最左/最右必定命中端点档位。
        var usable = rect.width - KNOB_RADIUS * 2;
        if (!(usable > 0)) return null;
        return clamp01((clientX - rect.left - KNOB_RADIUS) / usable);
      }

      /** 吞掉事件：滑条在官方的 <button> 里，不能让拖动触发那一行的 onClick（会跳进等级列表）。 */
      function swallow(event) {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      }

      function moveTo(clientX, immediate) {
        if (levelCount === 0) return;
        var pct = pctAt(clientX);
        if (pct === null) return;
        var index = indexFromPct(pct, levelCount);
        var next = { pct: pct, index: index };
        draftRef.current = next;
        setDraft(next);
        requestCommit(levels[index].id, immediate === true);
      }

      function endDrag() {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        var latest = draftRef.current;
        if (latest !== null && levelCount > 0) requestCommit(levels[latest.index].id, true);
        draftRef.current = null;
        setDraft(null);
      }

      function onTrackPointerDown(event) {
        if (locked || levelCount === 0) return;
        swallow(event);
        draggingRef.current = true;
        try {
          if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function" && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } catch (error) { /* 指针捕获失败不影响拖动 */ }
        moveTo(event.clientX, false);
      }

      function onTrackPointerMove(event) {
        if (!draggingRef.current) return;
        swallow(event);
        moveTo(event.clientX, false);
      }

      function onKeyDown(event) {
        if (locked || levelCount === 0) return;
        var key = event.key;
        var index = draftRef.current !== null ? draftRef.current.index : shownIndex;
        var next = null;
        if (key === "ArrowLeft" || key === "ArrowDown") next = Math.max(0, index - 1);
        else if (key === "ArrowRight" || key === "ArrowUp") next = Math.min(levelCount - 1, index + 1);
        else if (key === "Home") next = 0;
        else if (key === "End") next = levelCount - 1;
        else return; // Escape / Enter / Tab 交给官方菜单自己处理
        swallow(event);
        if (typeof event.preventDefault === "function") event.preventDefault();
        setDraft(null);
        requestCommit(levels[next].id, true);
      }

      var trackTitle = "推理等级" + (shownLevel !== null ? "：" + shownLevel.name : "");
      if (reducedMotion) trackTitle += "（系统「减少动态效果」已开启：粒子已放缓）";

      var tickNodes = [];
      for (var t = 0; t < levelCount; t += 1) {
        tickNodes.push(React.createElement("span", {
          key: "tick-" + levels[t].id,
          className: "ces-tick",
          "data-ces-part": "tick",
          "data-on": t <= shownIndex ? "1" : "0",
          style: { left: knobOffsetOf(pctFromIndex(t, levelCount)) },
        }));
      }

      // 星点：三层星带各自匀速左移，**亮度恒定**（不做任何闪烁）。
      // 每条带里星星铺在 [2%,48%]，另有一份复制品在 +50% 处；带子走完 -50% 时
      // 复制品正好接上 —— 所以看不到"闪现"，只有匀速流动。
      var starCount = starCountFor(shownPct);
      var starLayerOpacity = starLayerOpacityFor(shownPct);
      var slow = reducedMotion ? REDUCED_MOTION_SLOWDOWN : 1;
      var starFieldNodes = [];
      for (var layerIndex = 0; layerIndex < STAR_LAYERS.length; layerIndex += 1) {
        var layerDots = [];
        for (var s = 0; s < starCount; s += 1) {
          if (PARTICLES[s].layer !== layerIndex) continue;
          for (var copy = 0; copy < 2; copy += 1) {
            layerDots.push(React.createElement(
              "span",
              {
                key: "star-" + s + "-" + copy,
                className: "ces-star",
                "data-ces-part": "star",
                style: {
                  left: (PARTICLES[s].x + copy * 50).toFixed(2) + "%",
                  top: PARTICLES[s].y.toFixed(1) + "%",
                },
              },
              React.createElement("span", {
                className: "ces-star__dot",
                "data-ces-part": "particle",
                "data-brightness": starBrightnessFor(s).toFixed(3),
                style: { "--ces-s": starSizeFor(s).toFixed(2) + "px" },
              }),
            ));
          }
        }
        if (layerDots.length === 0) continue;
        starFieldNodes.push(React.createElement(
          "div",
          {
            key: "starfield-" + layerIndex,
            className: "ces-starfield",
            "data-ces-part": "starfield",
            style: {
              // ⚠️ 周期与负相位必须内联：写成 CSS 变量时真宿主里相位不生效（旧版踩过）
              animationDuration: (starLayerDurationFor(layerIndex) * slow).toFixed(2) + "s",
              animationDelay: (starLayerDelayFor(layerIndex) * slow).toFixed(2) + "s",
            },
          },
          layerDots,
        ));
      }

      var ui = null;
      if (host !== null && host.container && levelCount > 0) {
        ui = ReactDOM.createPortal(
          React.createElement(
            "div",
            {
              className: "ces-inline",
              "data-ces-part": "root",
              "data-energy": energyOn ? "1" : "0",
              "data-motion": reducedMotion ? "reduced" : "full",
              "data-busy": busy ? "1" : "0",
              style: { "--ces-energy": String(energy) },
            },
            React.createElement(
              "div",
              {
                ref: trackRef,
                className: "ces-track",
                "data-ces-part": "track",
                role: "slider",
                tabIndex: locked ? -1 : 0,
                "aria-label": "推理等级",
                "aria-valuemin": 0,
                "aria-valuemax": Math.max(0, levelCount - 1),
                "aria-valuenow": shownIndex,
                "aria-valuetext": shownLevel !== null ? shownLevel.name : "",
                "aria-disabled": locked ? "true" : undefined,
                title: trackTitle,
                onPointerDown: onTrackPointerDown,
                onPointerMove: onTrackPointerMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
                onKeyDown: onKeyDown,
                onClick: swallow,
              },
              React.createElement("div", {
                className: "ces-fill",
                "data-ces-part": "fill",
                // 填充宽度 = 到**旋钮右缘**为止。若只画到圆心，填充右端的圆弧（半径 12）
                // 与旋钮（半径 14、圆心再往右 14px）不同心，会在右上/右下角露出一块缺口。
                // 画到右缘后两条曲线恰好嵌套：圆心处相切、上下两行时填充边始终在旋钮之内。
                style: { width: fillWidth, background: fillBackground },
              }),
              // 能力层（静止底色 + 两层缓慢摆动的极光）：透明度 = 能量强度，负责"通电"的渐入。
              React.createElement(
                "div",
                { className: "ces-energy", "data-ces-part": "energy", style: { width: fillWidth } },
                React.createElement("div", { className: "ces-aurora", "data-ces-part": "aurora" }),
                React.createElement("div", { className: "ces-shade", "data-ces-part": "shade" }),
              ),
              // 星星单独一层：不跟星云淡入（否则 high 档星星被星云的 0.5 透明度压得看不见）。
              React.createElement(
                "div",
                {
                  className: "ces-stars",
                  "data-ces-part": "stars",
                  style: { width: fillWidth, opacity: starLayerOpacity.toFixed(3) },
                },
                starFieldNodes,
              ),
              tickNodes,
              React.createElement("div", {
                className: "ces-knob",
                "data-ces-part": "knob",
                style: { left: knobOffset },
              }),
            ),
            errorText_ !== null
              ? React.createElement("div", { className: "ces-error", "data-ces-part": "error", role: "status" }, errorText_)
              : null,
          ),
          host.container,
        );
      }

      // 锚点：不可见、不占位，只用来(1)拿住插槽给的 sessionId 上下文 (2)反查自己的 composer。
      return React.createElement("span", {
        ref: anchorRef,
        hidden: true,
        "data-ces-part": "anchor",
        "aria-hidden": "true",
      }, ui);
    }

    /* ════════════════════════════ 插件接线 ════════════════════════════ */

    /**
     * 三个服务都是官方客户端插件已经在用的（slots 不必说；sessions 与 modelDirectories
     * 是 client-ui-model-selection / client-ui-workspace 的既有注入面）。
     * 这里刻意**不**注入 locale / theme：多声明一个可能不存在的服务会让 fiber 停在
     * PENDING，代价远大于省下两行文案。
     */
    var inject = ["slots", "sessions", "modelDirectories"];

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "Reasoning effort"; },
              // 会话 id 的第二条来路（标准 props 一般已经带了；两条都走 props.sessionId）。
              inject: function (sessionId) { return { sessionId: sessionId }; },
            },
            function SlotComponent(props) {
              return React.createElement(CodexEffortSlider, Object.assign({}, props, { __ctx: ctx }));
            },
          );
        });
      } catch (error) {
        // 注册失败只意味着这块控件不出现，绝不能连累宿主输入区。
        try { console.error("[" + PACKAGE_ID + "] 插槽注册失败，控件不会出现：", error); } catch (e) { /* 忽略 */ }
      }
    }

    installStyles();

    exports.apply = apply;
    exports.inject = inject;
    // 离线测试用的接缝（纯函数 + 桥 + 组件本身）。运行时无副作用。
    exports.__internals = {
      CSS: CSS,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ID: ENTRY_ID,
      PARTICLES: PARTICLES,
      ROW_PADDING_BLOCK: ROW_PADDING_BLOCK,
      EFFORT_ROW_LABELS: EFFORT_ROW_LABELS,
      CodexEffortSlider: CodexEffortSlider,
      createMenuBridge: createMenuBridge,
      findEffortRow: findEffortRow,
      firstSpanText: firstSpanText,
      levelsOf: levelsOf,
      modelOf: modelOf,
      effectiveEffortId: effectiveEffortId,
      indexOfLevel: indexOfLevel,
      indexFromPct: indexFromPct,
      pctFromIndex: pctFromIndex,
      energyFor: energyFor,
      speedFor: speedFor,
      particleCountFor: particleCountFor,
      starCountFor: starCountFor,
      starLayerOpacityFor: starLayerOpacityFor,
      starBrightnessFor: starBrightnessFor,
      starDriftDurationFor: starDriftDurationFor,
      starDriftDelayFor: starDriftDelayFor,
      starSizeFor: starSizeFor,
      starLayerDurationFor: starLayerDurationFor,
      starLayerDelayFor: starLayerDelayFor,
      starHash01: starHash01,
      STAR_LAYERS: STAR_LAYERS,
      STARFIELD_MIN: STARFIELD_MIN,
      MAX_SPEED_FACTOR: MAX_SPEED_FACTOR,
      REDUCED_MOTION_SLOWDOWN: REDUCED_MOTION_SLOWDOWN,
      fillColorFor: fillColorFor,
      fillBackgroundFor: fillBackgroundFor,
      valueColorFor: valueColorFor,
      isOffLevel: isOffLevel,
      findValueElement: findValueElement,
      findSeatEffort: findSeatEffort,
      knobOffsetOf: knobOffsetOf,
      fillWidthOf: fillWidthOf,
      KNOB_RADIUS: KNOB_RADIUS,
      KNOB_SIZE: KNOB_SIZE,
      TRACK_HEIGHT: TRACK_HEIGHT,
      BASE_SPEEDUP: BASE_SPEEDUP,
      isMaxPct: isMaxPct,
      MAX_PCT: MAX_PCT,
      MAX_FILL_GRADIENT: MAX_FILL_GRADIENT,
      AURORA_GLOW: AURORA_GLOW,
      AURORA_SHADE: AURORA_SHADE,
      COLOR_BLUE: COLOR_BLUE,
      COLOR_TEXT_BLUE: COLOR_TEXT_BLUE,
      COLOR_TEXT_VIOLET: COLOR_TEXT_VIOLET,
      clamp01: clamp01,
      installStyles: installStyles,
    };

    return module.exports;
  },
});
