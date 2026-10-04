/**
 * content 侧的编排：把选区 → 浮标/面板 → 查词 串起来。
 *
 * 触发策略（设置项 `trigger`）：
 *   - `icon`（默认）：划选后浮出小图标，点它才开面板。双击选词可直接弹。
 *   - `dblclick`：只有双击（或右键菜单）才弹，普通划选不打扰。
 *   - `auto`：一有选区就弹，和阅读器一致。
 */

import { MSG } from '../core/protocol.js'
import { getSettings, isBlocked, onSettingsChanged } from '../core/settings.js'
import { isTranslateCandidate } from '../core/translator.js'
import { handleAudioTap } from '../render/audio.js'
import { createPanel } from './panel.js'
import { createTriggerIcon } from './trigger-icon.js'
import { createVocabCapability } from './vocab.js'
import {
  SELECTION_DEBOUNCE_MS,
  SELECTION_TOUCH_SETTLE_MS,
  isInEditable,
  isSelectionCollapsed,
  readSelection,
  UI_ATTR,
} from './selection.js'

export function start() {
  // 只跑在顶层文档；manifest 里 all_frames:false 已经挡了一层，这里再确认一次
  if (window.top !== window) return
  // SPA 反复注入 / 扩展重载后的重复执行
  if (window.__myreaderDictStarted) return
  window.__myreaderDictStarted = true

  let settings = null
  let iconAnchor = null

  const vocab = createVocabCapability('MyDict')
  const icon = createTriggerIcon({ onActivate: () => openPanelForSelection() })
  const panel = createPanel({
    lookup: (word) => chrome.runtime.sendMessage({ type: MSG.QUERY, payload: { word } }),
    vocab,
    getSettings: () => getSettings(),
    openOptions: () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }),
  })

  // 挂在 documentElement 上而不是 body：有些站点的框架会把 body 整个换掉
  document.documentElement.append(icon.host, panel.host)

  // ---------------------------------------------------------------- 触发

  function blockedHere() {
    return isBlocked(location.hostname, settings?.blocklist)
  }

  function currentSelectionRect() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    return selection.getRangeAt(0).getBoundingClientRect()
  }

  let lastOpenRect = null

  /**
   * 开面板。`rectOverride` 可选——调用方刚合成/刚拿到选区时把矩形直接递进来，
   * 免得再去读一次；没有就现场读当前选区。
   *
   * 线路自动判定：像句子（全非字母≥6字 / 英文≥3词）→ 面板直接落在「翻译」标签，
   * 否则照旧查词典——面板里随时可以用标签或 ←/→ 切到另一边。
   */
  function openPanelForSelection(rectOverride) {
    const selection = readSelection()
    if (!selection) return
    if (settings.disableInInputs && isInEditable(selection.container)) return
    icon.hide()
    const rect = rectOverride ?? selection.rect
    lastOpenRect = rect
    panel.open(selection.text, rect, settings, {
      translate: isTranslateCandidate(selection.text),
    })
  }

  function anchorMoved(rect) {
    if (!lastOpenRect || !rect) return true
    // 滚动会让视口坐标整体平移，所以只在「位移明显」时才换锚点；
    // 小幅抖动交给滚动跟随去处理，免得每次 selectionchange 都重开面板。
    return Math.abs(rect.top - lastOpenRect.top) > 8 || Math.abs(rect.left - lastOpenRect.left) > 8
  }

  function handleSelectionChanged() {
    if (!settings || blockedHere()) {
      icon.hide()
      return
    }

    const selection = readSelection()
    if (!selection) {
      // 选区塌陷就收掉浮标；**不关面板**——用户可能正在读面板，误点一下不该把它弄没
      // （面板有自己的「点外面关闭」和 Esc）
      icon.hide()
      return
    }

    if (settings.disableInInputs && isInEditable(selection.container)) {
      icon.hide()
      return
    }

    // 面板开着时又选了词：
    //   同一个词且位置没动 → 浮标收起即可，面板靠「滚动跟随」继续贴着它；
    //   换了词、或换了个地方选 → 换锚点重开（与阅读器一致：选区一变，面板就重新定位）。
    if (panel.isOpen) {
      icon.hide()
      if (panel.currentWord !== selection.text || anchorMoved(selection.rect)) {
        openPanelForSelection(selection.rect)
      }
      return
    }

    if (settings.trigger === 'dblclick') {
      icon.hide()
      return
    }

    // icon 模式：浮标形态随线路走——像句子显示「译」，像词显示「词」；
    // 位置取设置项 iconPlacement（安卓选择手柄会挡住右下角，用户可换角）
    iconAnchor = selection.rect
    icon.show(
      selection.rect,
      isTranslateCandidate(selection.text) ? 'translate' : 'word',
      settings.iconPlacement,
    )
  }

  let selectionTimer = 0
  document.addEventListener(
    'selectionchange',
    () => {
      clearTimeout(selectionTimer)
      selectionTimer = setTimeout(handleSelectionChanged, SELECTION_DEBOUNCE_MS)
    },
    true,
  )

  // 触屏补充触发：安卓系内核的 selectionchange 在「长按选词 / 拖动手柄」手势里的时序
  // 不稳——有的内核整个手势结束才补发，有的补发时选区 rect 还没布局好，只靠它浮标
  // 经常不出现（真机反馈：Chromium 系手机浏览器浮标完全不出现）。touchend 后延迟
  // 复查一次选区作为兜底；桌面端不会派发 touchend，无感。
  document.addEventListener(
    'touchend',
    () => {
      if (!settings || blockedHere()) return
      clearTimeout(selectionTimer)
      selectionTimer = setTimeout(handleSelectionChanged, SELECTION_TOUCH_SETTLE_MS)
    },
    { capture: true, passive: true },
  )

  // 用户点了别处（不是我们的 UI）→ 立刻收起浮标。
  //
  // 浮标本来只在选区塌陷时才收；但别的扩展（例如 NAVI 搜索扩展）点自己的浮标时会
  // preventDefault 保住选区，选区不塌陷我们就收不掉浮标，于是它一直挂在屏幕上、
  // 盖住别人的二级菜单。用户都已经点别处了，就不在「选词 → 点浮标」这条路径上了。
  document.addEventListener(
    'pointerdown',
    (event) => {
      // 注意用 hasAttribute：`node[UI_ATTR]` 这种把带连字符的属性当 JS 属性读取不到值
      const inOurUI = event
        .composedPath()
        .some((node) => node instanceof Element && node.hasAttribute(UI_ATTR))
      if (inOurUI) return
      icon.hide()
    },
    true,
  )

  // 发音兜底（document 捕获阶段）：个别安卓内核对面板内**两层 shadow 嵌套**的词条元素
  // 不派发 pointerup/click，元素级监听收不到、点音标「完全没反应」（单层 shadow 的浮标没事）。
  // 这里按 composedPath 兜底识别并播放；桌面端鼠标路径与之重复时由 600ms 防双播压掉。
  document.addEventListener(
    'pointerup',
    (event) => {
      if (event.pointerType !== 'touch') return
      if (handleAudioTap(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )
  document.addEventListener(
    'click',
    (event) => {
      if (handleAudioTap(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )

  // 双击是一个明确的手势：三种模式下都直接开面板
  document.addEventListener(
    'dblclick',
    (event) => {
      if (!settings || blockedHere()) return
      if (event.composedPath().some((node) => node?.[UI_ATTR] !== undefined)) return
      const selection = readSelection()
      if (!selection) return
      if (settings.disableInInputs && isInEditable(selection.container)) return
      icon.hide()
      openPanelForSelection(selection.rect)
    },
    true,
  )

  // ---------------------------------------------------------------- 跟随与关闭

  let rafId = 0
  function scheduleFollow() {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (isSelectionCollapsed()) {
        icon.hide()
      } else if (icon.visible && iconAnchor) {
        // 浮标跟着选区走；滚出视口就收起来
        const rect = currentSelectionRect()
        iconAnchor = rect
        if (rect) icon.show(rect, undefined, settings.iconPlacement)
        else icon.hide()
      }
      if (panel.isOpen) panel.follow()
    })
  }

  // 捕获阶段监听，才能收到内部滚动容器（不是 window 自己滚）的 scroll 事件
  document.addEventListener('scroll', scheduleFollow, { capture: true, passive: true })
  window.addEventListener('resize', scheduleFollow, { passive: true })

  // ---------------------------------------------------------------- 外部触发

  // popup 用 PING 判断「这个页面注入了没」——没注入时它能给出可操作的提示，
  // 而不是让用户面对「划选没反应」这种无声故障。
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.PING) {
      sendResponse({ ok: true, data: { started: window.__myreaderDictStarted === true } })
      return false
    }
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== MSG.TRIGGER) return
    const word = (message.payload?.word || '').trim()
    if (!word) return
    void (async () => {
      const rect = currentSelectionRect() ?? {
        left: window.innerWidth / 2,
        right: window.innerWidth / 2,
        top: window.innerHeight / 3,
        bottom: window.innerHeight / 3,
      }
      icon.hide()
      lastOpenRect = rect
      panel.open(word, rect, settings)
    })()
  })

  // ---------------------------------------------------------------- 启动

  void (async () => {
    settings = await getSettings()
    onSettingsChanged((next) => {
      settings = next
      if (blockedHere()) {
        icon.hide()
        panel.close()
      }
    })
  })()
}

/** 供 content.js 判断是否已经注入过。 */
export const UI_ATTRIBUTE = UI_ATTR
