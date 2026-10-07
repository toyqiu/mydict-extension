/**
 * 扩展工具栏图标的弹窗：搜索框 + 查词结果。
 *
 * 走这条路径而不是往页面里塞面板，是因为工具栏图标必须**在任何标签页都能用**——
 * 包括 chrome:// 新标签页、设置页这类注入不了 content script 的地方。
 * 渲染层与页面内面板完全同一套（renderer / sanitize / 资源改写 / 生词本星标）。
 */

import { CODE, MSG } from './core/protocol.js'
import { getSettings } from './core/settings.js'
import { isValidBase } from './core/mydict-url.js'
import { guessSourceLang, isTranslateCandidate } from './core/translator.js'
import { DICT_CHROME_CSS, PANEL_CSS } from './render/styles.js'
import { renderResults } from './render/renderer.js'
import { createVocabCapability } from './content/vocab.js'

const host = document.getElementById('host')
const shadow = host.attachShadow({ mode: 'open' })

const style = document.createElement('style')
style.textContent = PANEL_CSS + DICT_CHROME_CSS + `
  :host { display: block; width: 460px; }
  /* 容器用 .panel（PANEL_CSS 的 flex 列 + overflow:hidden + 主题背景都挂在它上面），
     这里只覆写弹窗自己的高度上限（Chrome 弹窗最高约 600px） */
  .panel { max-height: 580px; }
  .head .search { flex: 1; }
  .head .go {
    flex: none;
    border: 0;
    border-radius: 6px;
    background: var(--p-accent);
    color: #fff;
    font: inherit;
    font-size: 13px;
    padding: 4px 10px;
    cursor: pointer;
  }
`
shadow.appendChild(style)

const panel = document.createElement('div')
panel.className = 'panel'
panel.setAttribute('role', 'dialog')
panel.setAttribute('aria-label', 'MyDict 查词')
shadow.appendChild(panel)

// --- 头部：搜索框 ---
const head = document.createElement('div')
head.className = 'head'
const backBtn = document.createElement('button')
backBtn.type = 'button'
backBtn.className = 'icon-btn back'
backBtn.textContent = '‹'
backBtn.title = '返回上一个词'
backBtn.hidden = true
const searchInput = document.createElement('input')
searchInput.type = 'text'
searchInput.className = 'search'
searchInput.placeholder = '查词或翻译：≥6个非字母字 / ≥3个英文单词走翻译，回车'
searchInput.spellcheck = false
const goBtn = document.createElement('button')
goBtn.type = 'button'
goBtn.className = 'go'
goBtn.textContent = '查询'
head.append(backBtn, searchInput, goBtn)

// --- 主体 ---
const body = document.createElement('div')
body.className = 'body'
const content = document.createElement('div')
const toast = document.createElement('div')
toast.className = 'toast'
toast.hidden = true
body.append(content, toast)

panel.append(head, body)

let history = []
let requestToken = 0
let toastTimer = 0
let currentSettings = null
/**
 * 随机浏览当前态。「随机」是**「在线」右侧的一个标签**（不是搜索框旁的按钮），
 * 所以标签常驻、内容按态渲染；换词走面板里的「换一个 →」。
 */
let randomState = { active: false, dictionaryName: '', poolLabel: '', word: '' }
/** 最近一次渲染返回的键盘导航 API（↑/↓ 切词条分组、←/→ 切语言标签） */
let renderApi = null

const vocab = createVocabCapability('MyDict')

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

const STATE_COPY = {
  [CODE.NOT_CONFIGURED]: {
    title: '还没配置 MyDict',
    detail: '填上 MyDict 的地址（和 Token，如果想用生词本）就能开始查词。',
    setup: true,
  },
  [CODE.PERMISSION_MISSING]: {
    title: '还没授权访问 MyDict',
    detail: '去设置页点一次「保存」，允许访问那台服务器。',
    setup: true,
  },
  [CODE.AUTH]: {
    title: 'Token 不对',
    detail: '到 MyDict 网页的「Token 管理」重新生成一个，填进设置里。',
    setup: true,
  },
  [CODE.EMPTY]: { title: '没有词典收录这个词', detail: '' },
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

function renderState(copy, { onTranslate, onRetry } = {}) {
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
  retry.addEventListener('click', () => {
    // 随机浏览的错误页有自己的重试（历史栈里没有对应词条）
    if (onRetry) {
      onRetry()
      return
    }
    const previous = history[history.length - 1]
    if (!previous) return
    void runLookup(previous.text, { keepHistory: true, translate: previous.translate })
  })
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
    setup.addEventListener('click', () => chrome.runtime.openOptionsPage())
    actions.appendChild(setup)
  }
  state.appendChild(actions)
  content.appendChild(state)
}

function renderLoading(word, label) {
  clearContent()
  const state = document.createElement('div')
  state.className = 'state'
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;align-items:center;gap:8px'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  const text = document.createElement('span')
  text.textContent = label ?? `正在查「${word}」…`
  row.append(spinner, text)
  state.appendChild(row)
  content.appendChild(state)
}

/**
 * 构造「把一组查询结果渲染进面板」的函数。查词与随机浏览共用同一套渲染参数——
 * 抽出来是为了两条路都能挂上翻译/在线/生词本/图片灯箱这些旁路能力。
 */
function makeRenderWith(settings, dark, word) {
  return (results, translateActive, dictEmptyText) => {
    renderApi = renderResults(results, content, {
      baseUrl: settings.baseUrl,
      lang: navigator.language,
      vocab,
      onNavigate: (nextWord) => void runLookup(nextWord),
      onNotify: notify,
      isDarkMode: dark,
      audioEnabled: settings.enableAudio,
      // 与面板保持一致（弹窗是扩展页面，直连从不失败，这一层实际不会走到）
      sendBackground: (message) => chrome.runtime.sendMessage(message),
      // 翻译模式下「翻译」标签默认激活
      translate: {
        text: word,
        targetLang: settings.translateTargetLang,
        active: translateActive,
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
        openExternal: (url) => void chrome.tabs.create({ url }),
      },
      // 随机浏览：「在线」右侧的「随机」标签（对齐网页版），面板右侧是「换一个 →」
      random: {
        active: randomState.active,
        dictionaryName: randomState.dictionaryName,
        poolLabel: randomState.poolLabel,
        word: randomState.word,
        onNext: () => void runRandom(),
      },
      // popup 是 460px 小窗，扫描图在弹窗内永远放不大——点大图开独立标签页承载灯箱，
      // 那里才是真全屏（面板里点图仍然是就地遮罩）
      openImages: (urls, index, alt) => {
        const query = new URLSearchParams({
          urls: JSON.stringify(urls),
          index: String(index),
          alt,
        })
        void chrome.tabs.create({ url: `lightbox.html?${query.toString()}` })
      },
    })
  }
}

/** 历史栈条目：{ text, translate }——回退要还原「走的哪条线路」。 */
async function runLookup(word, { keepHistory = false, translate = false } = {}) {
  const token = ++requestToken
  // 查词即离开随机视图（「随机」标签仍在，只是不再激活）
  randomState = { ...randomState, active: false }
  if (!keepHistory) history.push({ text: word, translate })
  backBtn.hidden = history.length <= 1
  searchInput.value = word

  const settings = await getSettings()
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  host.setAttribute('data-theme', dark ? 'dark' : 'light')

    const renderWith = makeRenderWith(settings, dark, word)

  if (translate) {
    // 翻译不依赖 MyDict：先把译文视图立起来，词典分组等查询回来再补——
    // 服务端对长句的模糊查询可能很慢甚至超时，不能让它挡住译文
    clearContent()
    renderWith([], true)
  } else {
    renderLoading(word)
  }

  const result = await chrome.runtime.sendMessage({ type: MSG.QUERY, payload: { word } })
  if (token !== requestToken) return

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
      // 译文视图保留，词典这边的结果用 toast 说明
      notify('error', `词典查询失败（${STATE_COPY[result.code]?.title ?? result.message}），译文不受影响`)
    } else {
      const copy = STATE_COPY[result?.code] ?? STATE_COPY[CODE.ERROR]
      renderState({ ...copy, detail: copy.detail || result?.message || '' })
    }
    return
  }

  const { results, hitWord } = result.data
  if (!translate) searchInput.value = hitWord
  // translate 模式重渲染时翻译标签保持激活（译文命中缓存，瞬时补上）
  renderWith(results, translate)
}

function submit() {
  const word = searchInput.value.trim()
  if (!word) return
  // 线路自动判定：像句子（全非字母≥6字 / 英文≥3词）→ 翻译；否则查词典。
  // 面板里语言标签右边有「翻译」标签，两条线路随时可切。
  void runLookup(word, { translate: isTranslateCandidate(word) })
}

/**
 * 随机浏览：让 background 挑一条随机词条并取回它的词条 HTML，用查词那套渲染层显示，
 * 但落在**「在线」右侧的「随机」标签**下（面板右侧带「换一个 →」，对齐网页版）。
 * 不入历史栈（随机没有「上一个词」的语义）——错误页的重试由 onRetry 自己兜。
 */
async function runRandom() {
  const token = ++requestToken
  renderLoading('', '正在随机挑词条…')

  const settings = await getSettings()
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  host.setAttribute('data-theme', dark ? 'dark' : 'light')

  const result = await chrome.runtime.sendMessage({ type: MSG.RANDOM, payload: {} })
  if (token !== requestToken) return

  if (!result?.ok) {
    randomState = { ...randomState, active: false }
    const copy = STATE_COPY[result?.code] ?? STATE_COPY[CODE.ERROR]
    renderState(
      { ...copy, detail: copy.detail || result?.message || '' },
      { onRetry: () => void runRandom() },
    )
    return
  }

  const { results, hitWord, random } = result.data
  randomState = {
    active: true,
    dictionaryName: random?.dictionary_name || '',
    // 扩展的 v1 查询覆盖全部可用词典，没有「勾选范围」这一层
    poolLabel: '全部可用词典',
    word: hitWord,
  }
  searchInput.value = hitWord
  const renderWith = makeRenderWith(settings, dark, hitWord)
  renderWith(results, false)
}

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
})
goBtn.addEventListener('click', submit)
backBtn.addEventListener('click', () => {
  if (history.length <= 1) return
  history.pop()
  const previous = history[history.length - 1]
  history.pop()
  void runLookup(previous.text, { translate: previous.translate })
})

// 方向键导航：↑/↓ 在命中的词典分组间切换（关当前、开相邻），←/→ 切语言标签。
// 焦点在搜索框里时只接管 ↑/↓（单行输入框里这两个键没有编辑意义），
// ←/→ 留给光标移动——要切语言标签先 Tab 把焦点移出输入框。
window.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || !renderApi) return
  const editing = document.activeElement === searchInput
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    renderApi.moveGroup(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    renderApi.moveGroup(-1)
  } else if (!editing && event.key === 'ArrowRight') {
    event.preventDefault()
    renderApi.moveLang(1)
  } else if (!editing && event.key === 'ArrowLeft') {
    event.preventDefault()
    renderApi.moveLang(-1)
  }
})

// ---------------------------------------------------------------- 启动

/**
 * 当前页面的 content script 注入了吗？
 *
 * 划选浮标依赖 content script；popup 自己不依赖。注入失败时页面上的划选会「无声失效」，
 * 所以这里主动探一次，把原因直接摆给用户看。
 */
async function pingActiveTab() {
  try {
    // 本页可能以独立 popup 窗口运行（Firefox 点图标走 windows.create，IME 才能用），
    // currentWindow 是这个没有标签页的小窗 —— 探针要打在最近聚焦的**普通**浏览器窗口上
    const wins = await chrome.windows.getAll({ populate: true })
    const normal = wins.filter((w) => w.type === 'normal')
    const target = normal.find((w) => w.focused) ?? normal[normal.length - 1]
    const tab = target?.tabs?.find((t) => t.active)
    if (!tab?.id) return { injected: false, special: true }
    const replied = await Promise.race([
      chrome.tabs
        .sendMessage(tab.id, { type: MSG.PING })
        .then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
    return { injected: replied === true, tabId: tab.id, special: false }
  } catch {
    return { injected: false, special: true }
  }
}

/** 注入失败时的就地说明：三类原因对应用户能自己动手的三种修法。 */
function renderNotInjectedNotice(tabId, special) {
  const notice = document.createElement('div')
  notice.className = 'notice'
  const title = document.createElement('div')
  title.className = 'notice-title'
  title.textContent = '这个页面还没有注入查词脚本（划选暂不可用），弹窗查询不受影响'
  notice.appendChild(title)
  const list = document.createElement('ul')
  list.className = 'notice-list'
  const reasons = special
    ? ['这一类页面（浏览器内置页 / PDF 等）本来就不允许扩展注入。']
    : [
        '加载扩展之前就一直开着的标签页：刷新一次即可',
        '扩展详情里的「网站访问权限」被设成了「点击时」：改成「在所有网站上」',
        '这一类页面本身不允许扩展注入（chrome://、PDF 查看器等）',
      ]
  for (const reason of reasons) {
    const li = document.createElement('li')
    li.textContent = reason
    list.appendChild(li)
  }
  notice.appendChild(list)
  if (!special && typeof tabId === 'number') {
    const actions = document.createElement('div')
    actions.className = 'actions'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = '刷新这个页面'
    reload.addEventListener('click', () => {
      void chrome.tabs.reload(tabId)
      window.close()
    })
    actions.appendChild(reload)
    notice.appendChild(actions)
  }
  body.appendChild(notice)
}

void (async () => {
  // 模块跑起来了就置位，引导脚本不再放「正在初始化」占位（本模块是 deferred，
  // 执行早于 DOMContentLoaded，所以这里 remove 不到刚要被加上的那条，得靠标志位）
  window.__MYDICT_POPUP_READY = true
  document.getElementById('boot-mark')?.remove()
  currentSettings = await getSettings()
  const dark =
    currentSettings.theme === 'dark' ||
    (currentSettings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  host.setAttribute('data-theme', dark ? 'dark' : 'light')

  if (!currentSettings.baseUrl || !isValidBase(currentSettings.baseUrl)) {
    renderState(STATE_COPY[CODE.NOT_CONFIGURED])
    return
  }
  searchInput.focus()

  // 探针放最后：不挡搜索框，只补充「划选为什么没反应」的说明
  const ping = await pingActiveTab()
  if (!ping.injected) renderNotInjectedNotice(ping.tabId, ping.special)
})()
