/**
 * 面板外壳：宿主 + 自己的 shadow root + 状态机 + 历史栈 + 定位/关闭。
 *
 * 为什么整个面板（含折叠骨架）都在**我们自己的 shadow root** 里：页面 CSS 五花八门，
 * 面板样式必须完全不受影响。词典内容再往下嵌一层各自独立的 shadow（见 renderer.js），
 * 于是三层各管各的：
 *
 *   页面 CSS  ──✗──>  面板 shadow（我们的 UI）
 *   词典 CSS  ──✗──>  面板 shadow；只在它自己那层 shadow 里生效
 */

import { CODE, MSG } from '../core/protocol.js'
import { guessSourceLang, isTranslateCandidate } from '../core/translator.js'
import { PANEL_CSS, DICT_CHROME_CSS } from '../render/styles.js'
import { renderResults as renderResultsImpl } from '../render/renderer.js'
import { isLightboxOpen, closeLightbox } from '../render/lightbox.js'
import { computePlacement, isAnchorVisible, setImmuneStyles } from './position.js'
import { UI_ATTR, remeasureSelectionRect } from './selection.js'

/** 错误码 → 面板上要说的话 + 是否值得给一个「打开设置」的出口。 */
const STATE_COPY = {
  [CODE.NOT_CONFIGURED]: {
    title: '还没配置 MyDict',
    detail: '在设置里填上 MyDict 的地址（和 Token，如果你想用生词本）。',
    setup: true,
  },
  [CODE.PERMISSION_MISSING]: {
    title: '还没授权访问 MyDict',
    detail: '去设置页点一次「保存」，浏览器会问你是否允许访问那台服务器。',
    setup: true,
  },
  [CODE.AUTH]: {
    title: 'Token 不对',
    detail: 'MyDict 拒绝了这次请求。到 MyDict 网页的「Token 管理」重新生成一个，填进设置里。',
    setup: true,
  },
  [CODE.EMPTY]: { title: '没有词典收录这个词', detail: '换个词，或者确认一下该词典是否已启用。' },
  [CODE.NETWORK]: { title: '连不上 MyDict', detail: '检查地址、端口和网络连通性。', setup: true },
  [CODE.TIMEOUT]: { title: '查询超时', detail: '服务器响应太慢，稍后再试。' },
  [CODE.SERVER]: { title: 'MyDict 出错了', detail: '看下服务端日志。' },
  [CODE.UNSUPPORTED]: {
    title: '在线词典未开启',
    detail: 'MyDict 管理后台 → 系统设置 → 在线词典，开启后重试。',
    setup: true,
  },
  [CODE.ERROR]: { title: '查询失败', detail: '' },
}

export function createPanel({ lookup, vocab, getSettings, openOptions }) {
  const host = document.createElement('div')
  host.setAttribute(UI_ATTR, 'panel')
  setImmuneStyles(host, {
    position: 'fixed',
    'z-index': '2147483647',
    display: 'none',
    visibility: 'visible',
    opacity: '1',
  })
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = PANEL_CSS + DICT_CHROME_CSS
  shadow.appendChild(style)

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '词典')
  shadow.appendChild(panel)

  // --- 头部 ---
  const head = document.createElement('div')
  head.className = 'head'
  const backBtn = document.createElement('button')
  backBtn.type = 'button'
  backBtn.className = 'icon-btn back'
  backBtn.textContent = '‹'
  backBtn.title = '返回上一个词'
  backBtn.hidden = true
  const wordEl = document.createElement('span')
  wordEl.className = 'word'
  const fromEl = document.createElement('span')
  fromEl.className = 'from'
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  const speakBtn = document.createElement('button')
  speakBtn.type = 'button'
  speakBtn.className = 'icon-btn'
  speakBtn.textContent = '🔊'
  speakBtn.title = '朗读这个词'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'icon-btn'
  closeBtn.textContent = '✕'
  closeBtn.title = '关闭（Esc）'
  closeBtn.setAttribute('aria-label', '关闭')
  head.append(backBtn, wordEl, fromEl, spacer, speakBtn, closeBtn)

  // --- 主体 ---
  const body = document.createElement('div')
  body.className = 'body'
  const content = document.createElement('div')
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.hidden = true
  body.append(content, toast)

  panel.append(head, body)

  // --- 状态 ---
  let isOpen = false
  let anchorRect = null
  /** 递增令牌：每次 open 自增，异步回来的结果对不上就丢弃（避免旧的渲染盖住新的） */
  let requestToken = 0
  let history = []
  let toastTimer = 0
  /** 最近一次渲染返回的键盘导航 API（↑/↓ 切词条分组、←/→ 切语言标签） */
  let renderApi = null

  function notify(type, message) {
    clearTimeout(toastTimer)
    toast.textContent = message
    toast.className = `toast${type === 'ok' ? '' : ` ${type}`}`
    toast.hidden = false
    toastTimer = setTimeout(() => {
      toast.hidden = true
    }, 3200)
  }

  function clearContent() {
    content.textContent = ''
  }

  function renderState(copy, { onTranslate } = {}) {
    clearContent()
    const state = document.createElement('div')
    state.className = 'state'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = copy.title
    state.appendChild(title)
    if (copy.detail) {
      const detail = document.createElement('div')
      detail.className = 'detail'
      detail.textContent = copy.detail
      state.appendChild(detail)
    }
    const actions = document.createElement('div')
    actions.className = 'actions'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重试'
    retry.addEventListener('click', () =>
      void runLookup(history[history.length - 1], { keepHistory: true }),
    )
    actions.appendChild(retry)
    // 词典不命中的出口：手动改走翻译线路（短词不自动切，避免「还没查就跑翻译」的观感）
    if (onTranslate) {
      const tr = document.createElement('button')
      tr.type = 'button'
      tr.textContent = '翻译'
      tr.title = '改用 Edge 翻译这段文字'
      tr.addEventListener('click', onTranslate)
      actions.appendChild(tr)
    }
    if (copy.setup) {
      const setup = document.createElement('button')
      setup.type = 'button'
      setup.className = 'primary'
      setup.textContent = '打开设置'
      setup.addEventListener('click', () => openOptions?.())
      actions.appendChild(setup)
    }
    state.appendChild(actions)
    content.appendChild(state)
  }

  function renderLoading(word) {
    clearContent()
    const state = document.createElement('div')
    state.className = 'state'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px'
    const spinner = document.createElement('span')
    spinner.className = 'spinner'
    const text = document.createElement('span')
    text.textContent = `正在查「${word}」…`
    row.append(spinner, text)
    state.appendChild(row)
    content.appendChild(state)
  }

  async function runLookup(word, { keepHistory = false, translate = false } = {}) {
    const token = ++requestToken
    if (!keepHistory) history.push(word)
    backBtn.hidden = history.length <= 1
    wordEl.textContent = word
    fromEl.textContent = ''
    speakBtn.hidden = typeof speechSynthesis === 'undefined'

    const settings = await getSettings()
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    host.setAttribute('data-theme', dark ? 'dark' : 'light')

    const renderWith = (results, translateActive, dictEmptyText) => {
      renderApi = renderResultsImpl(results, content, {
        baseUrl: settings.baseUrl,
        lang: document.documentElement.lang || navigator.language,
        vocab,
        onNavigate: (nextWord) => void runLookup(nextWord),
        onNotify: notify,
        isDarkMode: dark,
        audioEnabled: settings.enableAudio,
        // 发音兜底通道（网页上下文里直连媒体可能被页面 CSP/跨站策略拦掉，经 background 取字节）
        sendBackground: (message) => chrome.runtime.sendMessage(message),
        // 翻译模式下「翻译」标签默认激活；译文请求自带缓存与 background 降级
        translate: {
          text: word,
          targetLang: settings.translateTargetLang,
          active: translateActive,
          // 词典查过且为空时给「词典」标签看说明，词典线路不失联
          dictEmptyText: dictEmptyText ?? null,
          sendBackground: (message) => chrome.runtime.sendMessage(message),
        },
        // 在线词典：服务端聚合 Wikipedia/Wiktionary/百度百科，懒加载
        online: {
          text: word,
          lang: guessSourceLang(word).slice(0, 2),
          active: false,
          lookup: (w, l) =>
            chrome.runtime.sendMessage({ type: MSG.ONLINE_LOOKUP, payload: { word: w, lang: l } }),
          openExternal: (url) => window.open(url, '_blank', 'noopener'),
        },
      })
    }

    if (translate) {
      // 翻译不依赖 MyDict：先把译文视图立起来，词典分组等查询回来再补——
      // 服务端对长句的模糊查询可能很慢甚至超时，不能让它挡住译文
      clearContent()
      renderWith([], true)
    } else {
      renderLoading(word)
    }

    const result = await lookup(word, settings)
    if (token !== requestToken || !isOpen) return // 期间关了面板或又查了新词

    if (!result?.ok) {
      // 查词不命中（EMPTY）：
      //   - 翻译候选（≥6 字 / ≥3 词）→ 自动切到翻译线路
      //   - 短词 → 留在词典错误页 + 手动「翻译」按钮（不自动切，避免「还没查就跑翻译」）
      if (result.code === CODE.EMPTY) {
        if (translate) {
          notify('ok', '没有词典收录这段文字，看「翻译」标签即可')
        } else if (isTranslateCandidate(word)) {
          clearContent()
          renderWith([], true, `「${word}」没有命中任何词典`)
          notify('ok', `没有词典收录「${word}」，已切换到翻译`)
        } else {
          renderState(
            { ...STATE_COPY[CODE.EMPTY], detail: '也可以改走翻译线路。' },
            {
              onTranslate: () => {
                clearContent()
                renderWith([], true, `「${word}」没有命中任何词典`)
              },
            },
          )
        }
        return
      }
      if (translate) {
        // 译文视图保留，词典这边的结果用 toast 说明（重渲染会打断用户读译文）
        notify('error', `词典查询失败（${STATE_COPY[result.code]?.title ?? result.message}），译文不受影响`)
      } else {
        const copy = STATE_COPY[result?.code] ?? STATE_COPY[CODE.ERROR]
        renderState({ ...copy, detail: copy.detail || result?.message || '' })
      }
      return
    }

    const { results, hitWord } = result.data
    wordEl.textContent = hitWord
    // 选区原文与真正命中的词头不同（大小写/词形还原）时说清楚，免得用户以为查错了
    if (word !== hitWord) fromEl.textContent = `（${word}）`
    // translate 模式重渲染时翻译标签保持激活（译文命中缓存，瞬时补上）
    renderWith(results, translate)
  }

  /** 按锚点重新摆放。滚动时反复调用。 */
  function reposition() {
    if (!isOpen || !anchorRect) return
    const settings = { width: Number(currentSettings?.panelWidth) || 480 }
    const placement = computePlacement(anchorRect, settings)
    // 位置/尺寸也走免疫内联样式，防止被页面或其它扩展的 !important 规则顶掉
    setImmuneStyles(host, {
      position: 'fixed',
      'z-index': '2147483647',
      visibility: 'visible',
      opacity: '1',
      left: placement.left + 'px',
      width: placement.width + 'px',
      top: placement.anchor.top !== undefined ? placement.anchor.top + 'px' : 'auto',
      bottom: placement.anchor.bottom !== undefined ? placement.anchor.bottom + 'px' : 'auto',
    })
    host.style.setProperty('--panel-max-height', `${placement.maxHeight}px`)
  }

  let currentSettings = null

  function open(word, rect, settings, { translate = false } = {}) {
    currentSettings = settings
    anchorRect = rect
    isOpen = true
    history = []
    void runLookup(word, { translate })
    // 先算好位置再显示（定位不依赖面板的实际高度，靠 top/bottom 锚定）
    reposition()
    setImmuneStyles(host, { display: 'block' })
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('pointerdown', onPointerDownCapture, true)
  }

  function close() {
    if (!isOpen) return
    isOpen = false
    requestToken += 1
    history = []
    renderApi = null
    // 词条正文渲染在面板外面也够不着的地方（scope shadow），面板关了灯箱就成了孤儿
    closeLightbox()
    setImmuneStyles(host, { display: 'none' })
    clearContent()
    clearTimeout(toastTimer)
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('pointerdown', onPointerDownCapture, true)
  }

  /** 滚动跟随：选区矩形是视口坐标，滚动后必须重测；测不到或滚出视口就关闭。 */
  function follow() {
    if (!isOpen) return
    const rect = remeasureSelectionRect()
    // 锚点滚出视口（翻页、跳转、长滚动）——面板钉在屏幕边上只会碍事
    if (!rect || !isAnchorVisible(rect)) {
      close()
      return
    }
    anchorRect = rect
    reposition()
  }

  function onKeydown(event) {
    // 灯箱开着时不插手：Esc/←/→ 已被它的 window 捕获监听拦下（到不了这里），
    // ↑/↓ 也不该在看图时切换分组
    if (isLightboxOpen()) return
    // 页面上的输入框里敲方向键是编辑光标的事，不抢
    const target = event.target
    if (
      target instanceof Element &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      close()
      return
    }
    if (!renderApi) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      renderApi.moveGroup(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      renderApi.moveGroup(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      renderApi.moveLang(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      renderApi.moveLang(-1)
    }
  }

  /** 点面板外面就关。用 composedPath 判断，才能穿透 shadow 边界认出自家人。
   *  大图查看器开着时让路：它的遮罩在面板宿主之外，而且它的 Esc 已在 window 捕获层
   *  把本监听挡掉了，这里只管指针——不然在图上拖动/点翻页按钮会把面板一起关掉。 */
  function onPointerDownCapture(event) {
    if (isLightboxOpen()) return
    if (event.composedPath().includes(host)) return
    close()
  }

  closeBtn.addEventListener('click', close)
  backBtn.addEventListener('click', () => {
    if (history.length <= 1) return
    history.pop()
    const previous = history[history.length - 1]
    history.pop()
    void runLookup(previous)
  })
  speakBtn.addEventListener('click', () => {
    if (typeof speechSynthesis === 'undefined') return
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(wordEl.textContent || '')
    utterance.lang = document.documentElement.lang || navigator.language || 'en'
    speechSynthesis.speak(utterance)
    // 朗读没有错误回调，给一条「已触发」反馈：能区分「点击没送达」与「TTS 静默失败」
    notify('ok', '🔊 朗读中…')
  })

  return {
    host,
    open,
    close,
    follow,
    reposition,
    get isOpen() {
      return isOpen
    },
    /** 当前面板里显示的词（供「同一个词不要重复开」判断） */
    get currentWord() {
      return history[history.length - 1] ?? ''
    },
  }
}
