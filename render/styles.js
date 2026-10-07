/**
 * 面板用到的全部 CSS，与阅读器参考实现一一对应。
 *
 * 与阅读器的**关键差异**：那边面板是 React 的 light DOM，所以词典的 CSS 必须靠
 * 「骨架留 light DOM、内容进 shadow」来隔离。扩展这边面板整体就在我们自己的 shadow
 * root 里，页面 CSS 根本够不着，所以分层更简单：
 *
 *   页面 DOM
 *     └─ 面板宿主（position: fixed）
 *          └─ 面板 shadow：PANEL_CSS + DICT_CHROME_CSS（折叠骨架、语言标签、星标）
 *               └─ 每词典一个宿主
 *                    └─ 词典 shadow：BASELINE_CSS + DICTIONARY_COMPAT_CSS + 词典自带 CSS + 词条
 *
 * 词典自带的 CSS 只在自己那层 shadow 里生效，打不到折叠骨架，也打不到别的词典——
 * 这正是「牛津10 的 `details{display:inline-block}` 把整组折叠框打崩」那个坑的解药。
 */

/** 语言分桶：zh-Hans/zh-Hant 都进 zh（词典自己会渲染变体）。兼容 ISO 639-1 与 639-2/B。 */
export function langBucket(lang) {
  const code = (lang ?? '').toLowerCase()
  if (code.startsWith('zh') || code.startsWith('zho')) return 'zh'
  if (code.startsWith('ja') || code.startsWith('jpn')) return 'ja'
  if (code.startsWith('en') || code.startsWith('eng')) return 'en'
  return code || ''
}

/** 语言标签页上的显示名（用该语言自己的写法）。 */
export const LANG_TAB_NAMES = {
  zh: '中文',
  ja: '日本語',
  en: 'English',
}

/** 代替词典自带脚本做的事（词条脚本在这里不执行）。一条规则对应一部词典。 */
export const DICTIONARY_COMPAT_CSS = `
  /* 小白词典（fy.js）：让它 CSS 显示出来的 .pf 链接带上图标 */
  .pf > a > img { display: inline-block !important; }
`

/** 词条内容的基线排版，作用在**每个词典自己的 shadow** 里，靠 currentColor 继承主题色。 */
export const BASELINE_CSS = `
  /* overflow-x 用 clip 而不是 hidden：clip 可以和纵向的 visible 配对，不会把卡片
     变成滚动容器。词典常把词条排得比面板宽（定宽表格、横幅图），不加这条会冒横向滚动条。
     mydict 自己的词条渲染也是这么做的。 */
  :host { display: block; overflow-x: clip; }
  /* flow-root 兜住词典的浮动布局：千篇那套 leftbox 是 float 且 1300px+ 高，在普通
     block 里父容器会塌成 0 高，浮动内容盖住下面所有分组，看起来就是「别的词典不见了」。 */
  .mydict-entry-body { display: flow-root; overflow-x: clip; }
  img, video { max-width: 100%; height: auto; }
  audio { max-width: 100%; }
  table { border-collapse: collapse; max-width: 100%; }
  th, td { padding: 0.25em 0.5em; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  hr { border: 0; border-top: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  a { color: inherit; }
  .mydict-entry + .mydict-entry {
    margin-top: 0.6em;
    padding-top: 0.5em;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  }
  .mydict-entry-head {
    margin-bottom: 0.35em;
    font-size: 0.8em;
    opacity: 0.75;
  }
  .mydict-entry-index {
    display: inline-block;
    min-width: 1.8em;
    margin-right: 0.3em;
    font-variant-numeric: tabular-nums;
  }
  .mydict-entry-word { font-weight: 600; }
  .mydict-entry-phonetic { margin-left: 0.35em; }
  /* 发音失败提示：链路上任何一步失败（取不到 / 解码失败 / 被自动播放策略拦）都不能静默，
     否则用户只看到「没声音」，连报什么都说不出来。 */
  .mydict-audio-note {
    margin-top: 0.4em;
    font-size: 0.78em;
    color: color-mix(in srgb, currentColor 60%, #d64545);
  }
`

/** 折叠骨架、语言标签、星标 —— 活在面板 shadow 里（词典 CSS 够不着）。 */
export const DICT_CHROME_CSS = `
  details.mydict-group[hidden] { display: none !important; }
  details.mydict-group + details.mydict-group {
    margin-top: 0.6em;
    padding-top: 0.6em;
    border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  }
  summary.mydict-group-head {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    cursor: pointer;
    font-size: 0.9em;
    outline-offset: 2px;
  }
  /* summary 变成 flex 之后原生三角会跑位，换成一个自绘 chevron */
  summary.mydict-group-head::marker,
  summary.mydict-group-head::-webkit-details-marker {
    content: '';
    display: none;
  }
  .mydict-group-chevron {
    flex: none;
    width: 0;
    height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 5px solid currentColor;
    opacity: 0.5;
    transform-origin: 25% 50%;
    transition: transform 0.15s ease;
  }
  details[open] > summary .mydict-group-chevron { transform: rotate(90deg); }
  summary.mydict-group-head:hover { color: color-mix(in srgb, currentColor 75%, transparent); }
  summary.mydict-group-head:hover .mydict-group-chevron { opacity: 0.8; }
  .mydict-group-name { font-weight: 600; }
  /* ---- 划词翻译标签页（render/renderer.js 的 translateBlock） ---- */
  .mydict-translate { padding: 0.4em 0.2em; }
  .mydict-translate-controls {
    display: flex;
    align-items: center;
    gap: 0.4em;
    font-size: 0.82em;
    opacity: 0.85;
    margin-bottom: 0.5em;
  }
  .mydict-translate-lang {
    font: inherit;
    font-size: inherit;
    color: inherit;
    background: color-mix(in srgb, currentColor 8%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    padding: 0.1em 0.4em;
  }
  .mydict-translate-original {
    font-size: 0.85em;
    opacity: 0.7;
    white-space: pre-wrap;
    word-break: break-word;
    padding-bottom: 0.5em;
    margin-bottom: 0.5em;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  }
  .mydict-translate-output {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
    font-size: 1.02em;
  }
  .mydict-translate-loading { display: flex; align-items: center; gap: 8px; opacity: 0.75; }
  .mydict-translate-error {
    color: color-mix(in srgb, currentColor 60%, #d64545);
    margin-bottom: 0.4em;
  }
  /* ---- 随机浏览标签页（render/renderer.js 的 randomBlock）----
     对齐网页版 RandomDictPanel：头部左「词典名 + 随机浏览 · N」、右「换一个 →」 */
  .mydict-random { padding: 0.2em 0.2em 0.4em; }
  .mydict-random-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6em;
    margin-bottom: 0.3em;
  }
  .mydict-random-meta {
    display: flex;
    flex-direction: column;
    gap: 0.1em;
    min-width: 0;
  }
  .mydict-random-dict {
    font-size: 0.8em;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mydict-random-pool { font-size: 0.8em; opacity: 0.6; }
  .mydict-random-actions {
    display: flex;
    align-items: center;
    gap: 0.5em;
    flex-shrink: 0;
  }
  .mydict-random .next-btn {
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.82em;
    padding: 0.25em 0.6em;
    white-space: nowrap;
    cursor: pointer;
  }
  .mydict-random .next-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .mydict-random-word {
    margin: 0 0 0.4em;
    font-size: 1.15em;
    font-weight: 600;
    line-height: 1.35;
    word-break: break-word;
  }
  /* 随机面板的正文不再重复一条折叠标题条：词典名与词已经在上面的头部里 */
  details.mydict-group-random > summary.mydict-group-head { display: none; }
  /* ---- 在线词典标签页（render/renderer.js 的 onlineBlock） ---- */
  .mydict-online { padding: 0.4em 0.2em; }
  .mydict-online-card {
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 8px;
    padding: 0.5em 0.7em;
    margin-bottom: 0.6em;
  }
  .mydict-online-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
    margin-bottom: 0.3em;
  }
  .mydict-online-name {
    font-weight: 600;
    font-size: 0.85em;
    opacity: 0.85;
  }
  .mydict-online-open,
  .mydict-online-ext {
    all: unset;
    cursor: pointer;
    font-size: 0.78em;
    color: color-mix(in srgb, currentColor 70%, #4a9d8e);
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  }
  .mydict-online-open:hover,
  .mydict-online-ext:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .mydict-online-title { font-weight: 600; margin-bottom: 0.2em; }
  .mydict-online-subtitle { font-size: 0.85em; opacity: 0.7; margin-bottom: 0.3em; }
  .mydict-online-text {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
    font-size: 0.95em;
  }
  .mydict-online-pos { font-weight: 600; font-size: 0.85em; margin: 0.4em 0 0.2em; opacity: 0.8; }
  .mydict-online-senses { margin: 0; padding-left: 1.2em; line-height: 1.5; font-size: 0.95em; }
  .mydict-online-example { font-size: 0.88em; opacity: 0.7; font-style: italic; margin-top: 0.1em; }
  .mydict-online-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4em;
    margin-top: 0.2em;
    font-size: 0.82em;
    opacity: 0.9;
  }
  .mydict-online-label { opacity: 0.7; }
  /* 生词本星标：每个词典分组一个，状态以服务端为准（★ 已收藏 / ☆ 未收藏） */
  .mydict-vocab-star {
    flex: none;
    margin-left: auto;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 1em;
    line-height: 1;
    padding: 0 0.15em;
    opacity: 0.55;
  }
  .mydict-vocab-star:hover { opacity: 1; }
  .mydict-vocab-star.saved { color: #d9a400; opacity: 1; }
  .mydict-vocab-star[disabled] { cursor: progress; opacity: 0.4; }
  .mydict-group-count,
  .mydict-lang-badge {
    font-size: 0.75em;
    font-weight: 400;
    opacity: 0.65;
  }
  .mydict-lang-badge {
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 4px;
    padding: 0 0.35em;
  }
  .mydict-lang-tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35em;
    margin: 0.4em 0 0.6em;
  }
  .mydict-lang-tab {
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 999px;
    padding: 0.1em 0.7em;
    font-size: 0.78em;
    cursor: pointer;
    opacity: 0.7;
    background: transparent;
    color: inherit;
  }
  .mydict-lang-tab:hover { opacity: 1; }
  .mydict-lang-tab-active {
    background: color-mix(in srgb, currentColor 12%, transparent);
    opacity: 1;
  }
`

/**
 * 面板外壳与状态页。
 *
 * 主题用 `:host([data-theme='dark'])` 切换——宿主上的属性由面板自己设置，
 * 这样「跟随系统 / 强制浅色 / 强制深色」三种设置都能落到同一个地方。
 * 面板内部一概用这组变量，不引用页面上的任何东西。
 */
export const PANEL_CSS = `
  :host {
    --p-bg: #ffffff;
    --p-surface: #f6f8f7;
    --p-fg: #16211c;
    --p-muted: #5b6b65;
    --p-border: #dbe2de;
    --p-accent: #2f6f5e;
    /* 滚动条：浅底上用深色半透明，hover 加深一档 */
    --p-scrollbar: rgba(22, 33, 28, 0.24);
    --p-scrollbar-hover: rgba(22, 33, 28, 0.42);
    all: initial;
  }
  :host([data-theme='dark']) {
    --p-bg: #1b2126;
    --p-surface: #232b31;
    --p-fg: #eaf1ee;
    --p-muted: #9db0aa;
    --p-border: #2c363d;
    --p-accent: #4aa88c;
    /* 深底上反过来用浅色半透明 */
    --p-scrollbar: rgba(234, 241, 238, 0.24);
    --p-scrollbar-hover: rgba(234, 241, 238, 0.42);
  }

  * { box-sizing: border-box; }

  .panel {
    display: flex;
    flex-direction: column;
    max-height: var(--panel-max-height, 80vh);
    background: var(--p-bg);
    color: var(--p-fg);
    border: 1px solid var(--p-border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei',
      'Segoe UI', sans-serif;
    text-align: left;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 12px;
    border-bottom: 1px solid var(--p-border);
    background: var(--p-surface);
    flex: none;
  }
  .head .word {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head .search {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border: 1px solid var(--p-border);
    border-radius: 6px;
    background: var(--p-bg);
    color: var(--p-fg);
    font: inherit;
    font-size: 14px;
  }
  .head .search:focus {
    outline: 2px solid var(--p-accent);
    outline-offset: -1px;
  }
  .head .search::placeholder { color: var(--p-muted); }
  /* 选区原文与真正命中的词头不一致时（大小写/词形还原），把归一化过程显示出来 */
  .head .from {
    font-size: 12px;
    color: var(--p-muted);
    flex: none;
  }
  .head .spacer { margin-left: auto; }
  .icon-btn {
    flex: none;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 14px;
    line-height: 1.2;
    opacity: 0.7;
  }
  .icon-btn:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
  .icon-btn.back { font-size: 16px; }

  .body {
    padding: 10px 12px 12px;
    overflow-y: auto;
    overscroll-behavior: contain;
    min-height: 0;
    /* 细滚动条 + 颜色随主题：标准属性（Chrome 121+）给形状和配色 */
    scrollbar-width: thin;
    scrollbar-color: var(--p-scrollbar) transparent;
  }
  /* webkit 规则给得更细的观感（圆角、hover 加深、轨道透明），与上面并存 */
  .body::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  .body::-webkit-scrollbar-track {
    background: transparent;
  }
  .body::-webkit-scrollbar-thumb {
    background: var(--p-scrollbar);
    border-radius: 4px;
  }
  .body::-webkit-scrollbar-thumb:hover {
    background: var(--p-scrollbar-hover);
  }

  .state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
    color: var(--p-muted);
    padding: 6px 2px 10px;
  }
  .state .title { color: var(--p-fg); font-weight: 600; }
  .state .detail { font-size: 13px; line-height: 1.5; }
  .state .actions { display: flex; gap: 8px; margin-top: 2px; }
  .state button {
    font: inherit;
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--p-border);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .state button.primary {
    background: var(--p-accent);
    border-color: var(--p-accent);
    color: #fff;
  }

  .spinner {
    width: 14px; height: 14px;
    border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: p-spin 0.7s linear infinite;
  }
  @keyframes p-spin { to { transform: rotate(360deg); } }

  /* 星标等按钮上的瞬时反馈；toast 是页面级的，这里用就地提示不打断浏览 */
  .toast {
    margin-top: 8px;
    font-size: 12.5px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  .toast.warn { color: #b58105; }
  .toast.error { color: #c0392b; }
  .toast[hidden] { display: none; }

  /* 弹窗里的「本页未注入」说明：划选不可用是有原因的，摆出来让用户自己动手 */
  .notice {
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--p-muted);
    line-height: 1.5;
  }
  .notice-title { font-weight: 600; color: var(--p-fg); margin-bottom: 4px; }
  .notice-list { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 2px; }
`
