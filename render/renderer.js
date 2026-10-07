/**
 * 把一次查询的结果渲染成面板内容。移植自 MyReader 的 `renderMyBooksResults`。
 *
 * 两条贯穿始终的设计（都是踩过坑的结论）：
 *
 * 1. **每个词典一个独立 shadow scope**。词典会用裸元素选择器写样式（`div`、
 *    `li{float:left}`、`table{…}`），共用一个 shadow 时千篇的规则会把英文字典的列表重排。
 *    每个 scope 多一个 shadow，换来的是精确的隔离。
 * 2. **折叠骨架留在面板自己的 shadow 里**，词典内容进各自的 scope。牛津10 的 CSS 有
 *    `details{display:inline-block}` 和 `details[open]>summary>span{display:none}`
 *    （它自己的页面拿 details 当折叠框用），骨架要是和词典 CSS 同层，整组会被打崩。
 */

import { BASELINE_CSS, LANG_TAB_NAMES, DICTIONARY_COMPAT_CSS, langBucket } from './styles.js'
import { sanitizeDictionaryHtml } from './sanitize.js'
import { absolutizeResourceRefs, extractEntryStyles } from './resources.js'
import { attachVocabStar } from './vocab-star.js'
import { wireLinks } from './links.js'
import { wireDictAudio } from './audio.js'
import { wireImageInteractions } from './expandable.js'
import { adaptToDarkTheme } from './dark-theme.js'
import { translateText, TRANSLATOR_LANGS, effectiveTargetLang } from '../core/translator.js'

/** 翻译标签页的伪语言值（不与真实语言桶冲突）。 */
export const TRANSLATE_TAB = '__translate__'
/** 词典空结果时的「词典」伪标签：让词典线路在翻译视图里保持可达。 */
export const DICT_TAB = '__dict__'
/** 在线词典标签页（Wikipedia / Wiktionary / 百度百科，服务端聚合）。 */
export const ONLINE_TAB = '__online__'
/** 随机浏览标签页（紧随「在线」之后，对齐网页版的标签顺序与面板形态）。 */
export const RANDOM_TAB = '__random__'

/**
 * @param {Array} results 服务端返回的 `results`
 * @param {HTMLElement} container 面板 shadow 里的内容容器（每次渲染前会被清空）
 * @param {object} options
 */
/** 在线词典模块级缓存（key = `${lang}:${text}`）。服务端还有一层 600s TTL 缓存。 */
const onlineCache = new Map()

/** 渲染在线词典返回的 sections + links（服务端已纯文本化，全部 textContent 注入）。 */
function renderOnlinePayload(container, payload, openExternal) {
  const sections = payload?.sections || []
  if (sections.length === 0 && !(payload?.links || []).length) {
    const empty = document.createElement('div')
    empty.className = 'mydict-translate-error'
    empty.textContent = '在线词典没有返回内容'
    container.appendChild(empty)
    return
  }
  for (const section of sections) {
    const card = document.createElement('div')
    card.className = 'mydict-online-card'

    const head = document.createElement('div')
    head.className = 'mydict-online-head'
    const name = document.createElement('span')
    name.className = 'mydict-online-name'
    name.textContent = section.name || section.id || ''
    head.appendChild(name)
    if (section.url) {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'mydict-online-open'
      open.textContent = '在新标签页打开 ↗'
      open.title = section.url
      open.addEventListener('click', () => openExternal?.(section.url))
      head.appendChild(open)
    }
    card.appendChild(head)

    if (section.title) {
      const title = document.createElement('div')
      title.className = 'mydict-online-title'
      title.textContent = section.title
      card.appendChild(title)
    }
    if (section.subtitle) {
      const subtitle = document.createElement('div')
      subtitle.className = 'mydict-online-subtitle'
      subtitle.textContent = section.subtitle
      card.appendChild(subtitle)
    }
    if (section.text) {
      const text = document.createElement('div')
      text.className = 'mydict-online-text'
      text.textContent = section.text
      card.appendChild(text)
    }
    for (const entry of section.entries || []) {
      const pos = document.createElement('div')
      pos.className = 'mydict-online-pos'
      pos.textContent = [entry.pos, entry.language].filter(Boolean).join(' · ')
      card.appendChild(pos)
      const senses = document.createElement('ul')
      senses.className = 'mydict-online-senses'
      for (const sense of entry.senses || []) {
        const li = document.createElement('li')
        li.textContent = sense.text || ''
        for (const example of sense.examples || []) {
          const ex = document.createElement('div')
          ex.className = 'mydict-online-example'
          ex.textContent = example
          li.appendChild(ex)
        }
        senses.appendChild(li)
      }
      card.appendChild(senses)
    }
    container.appendChild(card)
  }

  const links = payload?.links || []
  if (links.length > 0) {
    const row = document.createElement('div')
    row.className = 'mydict-online-links'
    const label = document.createElement('span')
    label.className = 'mydict-online-label'
    label.textContent = '外部打开：'
    row.appendChild(label)
    for (const link of links) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mydict-online-ext'
      btn.textContent = link.name || link.id
      btn.title = link.url
      btn.addEventListener('click', () => openExternal?.(link.url))
      row.appendChild(btn)
    }
    container.appendChild(row)
  }
}

export function renderResults(results, container, options) {
  const {
    baseUrl,
    lang,
    vocab,
    onNavigate,
    onNotify,
    isDarkMode,
    audioEnabled,
    translate,
    online,
    random,
  } = options
  container.textContent = ''

  // 服务端已按词典排序，所以「折叠连续同名」就保住了顺序，不需要额外的索引表
  const groups = []
  for (const result of results) {
    const name = result.dictionary_name || '未命名词典'
    // 随机浏览：整组固定挂在「随机」伪标签下（面板只在选中该标签时可见）
    const bucket = random?.active ? RANDOM_TAB : langBucket(result.lang_from)
    const last = groups[groups.length - 1]
    if (last && last.name === name) last.items.push(result)
    else groups.push({ name, lang: bucket, items: [result] })
  }

  const langOrder = []
  for (const group of groups) {
    if (!langOrder.includes(group.lang)) langOrder.push(group.lang)
  }
  // 默认选中与页面语言命中一致的那一组：日文网页上查汉字，日文词典排在前面才对。
  // 页面语言没有命中就回到「全部」。
  const pageLang = langBucket(lang)
  // 「译」图标/搜索框判定进来的直接落在翻译标签上；随机浏览落在「随机」标签上；否则回默认词典组
  let activeLang = random?.active
    ? RANDOM_TAB
    : translate?.active
      ? TRANSLATE_TAB
      : langOrder.includes(pageLang)
        ? pageLang
        : ''

  // 同一次渲染里，同一个词头的已收藏状态只查一次
  const savedByWord = new Map()
  const savedFor = (word) => {
    let saved = savedByWord.get(word)
    if (!saved) {
      saved = vocab?.listSaved(word) ?? Promise.resolve(new Map())
      savedByWord.set(word, saved)
    }
    return saved
  }

  const scopes = []
  let openedVisibleGroup = false
  const applyLangFilter = (selected) => {
    for (const scope of scopes) {
      const visible = selected === '' || scope.lang === selected
      scope.details.style.display = visible ? '' : 'none'
      if (selected !== '' && scope.lang !== selected) scope.details.open = false
    }
    if (translateBlock) translateBlock.style.display = selected === TRANSLATE_TAB ? '' : 'none'
    if (dictEmptyBlock) dictEmptyBlock.style.display = selected === DICT_TAB ? '' : 'none'
    if (onlineBlock) onlineBlock.style.display = selected === ONLINE_TAB ? '' : 'none'
    if (randomBlock) randomBlock.style.display = selected === RANDOM_TAB ? '' : 'none'
  }

  // 语言标签页：多语言、或带翻译/词典空标签时才值得占一行。
  // 注意 translate 模式下**只有一个语言桶也要造标签**——否则词典分组渲染了却不可达，
  // 表象就是「默认落在翻译标签后切不回词典」（真机踩过）。
  const tabButtons = []
  if (langOrder.length > 1 || translate) {
    const tabs = document.createElement('div')
    tabs.className = 'mydict-lang-tabs'
    tabs.addEventListener('click', (event) => event.stopPropagation())
    const makeTab = (value, label) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.textContent = label
      tab.className = `mydict-lang-tab${value === activeLang ? ' mydict-lang-tab-active' : ''}`
      tab.addEventListener('click', () => selectLang(value))
      tabButtons.push({ value, tab })
      return tab
    }
    if (langOrder.length >= 1) {
      if (langOrder.length > 1) tabs.appendChild(makeTab('', '全部'))
      for (const bucket of langOrder) tabs.appendChild(makeTab(bucket, LANG_TAB_NAMES[bucket] ?? bucket))
    }
    // 词典查过且为空：给一个「词典」标签，点过去看「没有收录」的说明，词典线路不失联
    const dictEmpty = Boolean(translate?.dictEmptyText) && langOrder.length === 0
    if (dictEmpty) tabs.appendChild(makeTab(DICT_TAB, '词典'))
    // 「在线」= 服务端聚合的 Wikipedia / Wiktionary / 百度百科；「随机」紧随其后（对齐网页版）；
    // 「翻译」保持最右
    if (online) tabs.appendChild(makeTab(ONLINE_TAB, '在线'))
    if (random) tabs.appendChild(makeTab(RANDOM_TAB, '随机'))
    if (translate) tabs.appendChild(makeTab(TRANSLATE_TAB, '翻译'))
    container.appendChild(tabs)
  }

  // 「词典」空结果说明块（只在词典伪标签激活时可见）
  const dictEmptyBlock = translate?.dictEmptyText && langOrder.length === 0 ? document.createElement('div') : null
  if (dictEmptyBlock) {
    dictEmptyBlock.className = 'state'
    dictEmptyBlock.style.display = activeLang === DICT_TAB ? '' : 'none'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = '没有词典收录'
    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.textContent = translate.dictEmptyText
    dictEmptyBlock.append(title, detail)
    container.appendChild(dictEmptyBlock)
  }

  // ---------------------------------------------------------- 翻译标签页的内容

  const translateBlock = translate ? document.createElement('div') : null
  if (translateBlock) {
    translateBlock.className = 'mydict-translate'
    translateBlock.style.display = activeLang === TRANSLATE_TAB ? '' : 'none'

    const controls = document.createElement('div')
    controls.className = 'mydict-translate-controls'
    const label = document.createElement('span')
    label.className = 'mydict-translate-label'
    label.textContent = '译成'
    const langSelect = document.createElement('select')
    langSelect.className = 'mydict-translate-lang'
    for (const { value, label: name } of TRANSLATOR_LANGS) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = name
      langSelect.appendChild(option)
    }
    // 初值 = 按选区语言自动纠偏后的目标语言；用户手动改了就以手动的为准
    langSelect.value = effectiveTargetLang(translate.text, translate.targetLang)
    controls.append(label, langSelect)
    translateBlock.appendChild(controls)

    const original = document.createElement('div')
    original.className = 'mydict-translate-original'
    original.textContent = translate.text
    translateBlock.appendChild(original)

    const output = document.createElement('div')
    output.className = 'mydict-translate-output'
    translateBlock.appendChild(output)
    container.appendChild(translateBlock)

    /** 请求令牌：换语言/重开面板后回来的旧响应直接丢弃。 */
    let translateToken = 0
    async function runTranslate() {
      const token = ++translateToken
      output.textContent = ''
      const row = document.createElement('div')
      row.className = 'mydict-translate-loading'
      const spinner = document.createElement('span')
      spinner.className = 'spinner'
      row.append(spinner, document.createTextNode('正在翻译…'))
      output.appendChild(row)
      try {
        const translated = await translateText(translate.text, {
          targetLang: langSelect.value,
          from: '',
          // 下拉框是用户显式选择，不再做「与源语言同桶纠偏」
          exact: true,
          sendBackground: options.sendBackground,
        })
        if (token !== translateToken) return
        output.textContent = translated || '（译文为空）'
      } catch (error) {
        if (token !== translateToken) return
        output.textContent = ''
        const fail = document.createElement('div')
        fail.className = 'mydict-translate-error'
        fail.textContent = `翻译失败：${error?.message || error}`
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.textContent = '重试'
        retry.addEventListener('click', () => void runTranslate())
        output.append(fail, retry)
      }
    }

    langSelect.addEventListener('change', () => void runTranslate())
    // 首次切到翻译标签（或以翻译标签开场）时才真正发请求——词典结果在大多数情况下用不上译文
    if (activeLang === TRANSLATE_TAB) {
      translateBlock.loaded = true
      void runTranslate()
    }
    translateBlock.load = runTranslate
    translateBlock.visible = () => translateBlock.style.display !== 'none'
  }

  // ---------------------------------------------------------- 在线词典标签页

  const onlineBlock = online ? document.createElement('div') : null
  if (onlineBlock) {
    onlineBlock.className = 'mydict-online'
    onlineBlock.style.display = activeLang === ONLINE_TAB ? '' : 'none'
    const output = document.createElement('div')
    onlineBlock.appendChild(output)
    container.appendChild(onlineBlock)

    let onlineToken = 0
    async function runOnlineLookup() {
      const token = ++onlineToken
      output.textContent = ''
      const row = document.createElement('div')
      row.className = 'mydict-translate-loading'
      const spinner = document.createElement('span')
      spinner.className = 'spinner'
      row.append(spinner, document.createTextNode('正在查询在线词典…'))
      output.appendChild(row)

      const key = `${online.lang}:${online.text}`
      let payload = onlineCache.get(key)
      if (!payload) {
        const result = await online.lookup(online.text, online.lang)
        if (token !== onlineToken) return
        if (!result?.ok) {
          output.textContent = ''
          const fail = document.createElement('div')
          fail.className = 'mydict-translate-error'
          let message = result?.message || '在线词典查询失败'
          // 剩余到达这里的鉴权失败（匿名也被拒）：服务端没开「开放使用」且无网页登录态
          if (result?.code === 'AUTH') {
            message = `在线词典鉴权失败：${message}`
          }
          fail.textContent = message
          output.appendChild(fail)
          return
        }
        payload = result.data
        onlineCache.set(key, payload)
      }
      if (token !== onlineToken) return
      output.textContent = ''
      renderOnlinePayload(output, payload, online.openExternal)
    }
    if (activeLang === ONLINE_TAB) {
      onlineBlock.loaded = true
      void runOnlineLookup()
    }
    onlineBlock.load = runOnlineLookup
  }

  // ---------------------------------------------------------- 随机浏览面板
  // 对齐网页版 RandomDictPanel：头部左边是「词典名 + 随机浏览 · N」，右边是「换一个 →」，
  // 下面是词条大标题与词条正文（正文由下面的分组骨架渲染）。
  const randomBlock = random ? document.createElement('div') : null
  if (randomBlock) {
    randomBlock.className = 'mydict-random'
    randomBlock.style.display = activeLang === RANDOM_TAB ? '' : 'none'
    // 本次渲染本来就是随机视图时，面板已「加载过」——再点「随机」标签不该重新挑词
    randomBlock.loaded = Boolean(random.active)
    const head = document.createElement('header')
    head.className = 'mydict-random-head'
    const meta = document.createElement('div')
    meta.className = 'mydict-random-meta'
    const dictName = document.createElement('span')
    dictName.className = 'mydict-random-dict'
    dictName.textContent = random.dictionaryName || ''
    const pool = document.createElement('span')
    pool.className = 'mydict-random-pool'
    pool.textContent = `随机浏览 · ${random.poolLabel || '全部可用词典'}`
    meta.append(dictName, pool)
    const actions = document.createElement('div')
    actions.className = 'mydict-random-actions'
    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'next-btn'
    nextBtn.textContent = '换一个 →'
    nextBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      random.onNext?.()
    })
    actions.appendChild(nextBtn)
    head.append(meta, actions)
    randomBlock.appendChild(head)
    if (random.word) {
      const wordEl = document.createElement('h2')
      wordEl.className = 'mydict-random-word'
      wordEl.textContent = random.word
      randomBlock.appendChild(wordEl)
    }
    container.appendChild(randomBlock)
  }

  for (const group of groups) {
    // 原生 <details>：一个分组可能装着几十个同形词（搜韵），全展开会把用户要找的那个埋掉。
    // 只有第一个「在当前语言下可见」的分组默认展开。
    const details = document.createElement('details')
    // 随机浏览的正文不要折叠标题条：面板头部已经有词典名与词条大标题（对齐网页版）
    details.className = random?.active ? 'mydict-group mydict-group-random' : 'mydict-group'
    details.dataset.lang = group.lang
    container.appendChild(details)

    const summary = document.createElement('summary')
    summary.className = 'mydict-group-head'
    // 面板整体没有「点卡片折叠」的行为，但仍然拦一下：避免点击穿透到页面
    summary.addEventListener('click', (event) => event.stopPropagation())

    const chevron = document.createElement('span')
    chevron.className = 'mydict-group-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    summary.appendChild(chevron)

    const nameEl = document.createElement('span')
    nameEl.className = 'mydict-group-name'
    nameEl.textContent = group.name
    summary.appendChild(nameEl)

    if (group.items.length > 1) {
      const count = document.createElement('span')
      count.className = 'mydict-group-count'
      count.textContent = String(group.items.length)
      summary.appendChild(count)
    }

    // 整组都是 lang_match=false，说明命中的是服务端跨语言兜底的结果（导入时的语言识别
    // 可能不准），标出来免得用户困惑
    if (group.items.every((item) => item.lang_match === false)) {
      const badge = document.createElement('span')
      badge.className = 'mydict-lang-badge'
      badge.textContent = '其它语言'
      summary.appendChild(badge)
    }

    // 星标发**该组首条命中的词头**，不是选区原文——生词本是词条级的，服务端精确匹配，
    // 而查询是前缀匹配（查 `ran` 可能命中 `ranch`）。这条是硬要求，别改成选区文字。
    const firstHit = group.items[0]
    if (vocab && firstHit && typeof firstHit.dictionary_id === 'number' && firstHit.word) {
      attachVocabStar(summary, {
        capability: vocab,
        dictionaryId: firstHit.dictionary_id,
        word: firstHit.word,
        savedFor,
        onNotify,
      })
    }

    details.appendChild(summary)

    const scopeHost = document.createElement('div')
    scopeHost.className = 'mydict-scope'
    details.appendChild(scopeHost)
    const shadow = scopeHost.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = BASELINE_CSS + DICTIONARY_COMPAT_CSS
    shadow.appendChild(style)

    // 词典自带的样式表：DOMPurify 会无条件丢掉它们，在这里逐条挂回**本分组的 scope**。
    // 挂在这里它们既生效，又够不到别的词典和面板骨架。
    const seenStyles = new Set()
    for (const item of group.items) {
      for (const node of extractEntryStyles(item.definition ?? '', baseUrl)) {
        const key =
          node.tagName === 'LINK' ? `link:${node.getAttribute('href')}` : `css:${node.textContent}`
        if (seenStyles.has(key)) continue
        seenStyles.add(key)
        shadow.appendChild(node)
      }
    }

    // part="dict-content" 是唯一能穿透 shadow 边界的钩子，面板的字号设置靠它生效
    const body = document.createElement('div')
    body.setAttribute('part', 'dict-content')
    shadow.appendChild(body)

    const multiple = group.items.length > 1
    group.items.forEach((item, index) => {
      const section = document.createElement('section')
      section.className = 'mydict-entry'

      // 只有「一部词典一次返回多条」时才值得加词头：序号是区分它们的唯一线索。
      // 单条的正文几乎都以自己的词头开头（汉典就是「天性 天性拼音：…」），再加一行只是重复。
      if (multiple) {
        const head = document.createElement('div')
        head.className = 'mydict-entry-head'
        const ordinal = document.createElement('span')
        ordinal.className = 'mydict-entry-index'
        ordinal.textContent = `${index + 1}/${group.items.length}`
        head.appendChild(ordinal)
        if (item.word) {
          const word = document.createElement('span')
          word.className = 'mydict-entry-word'
          word.textContent = item.word
          head.appendChild(word)
        }
        if (item.phonetic) {
          const phonetic = document.createElement('span')
          phonetic.className = 'mydict-entry-phonetic'
          phonetic.textContent = item.phonetic
          head.appendChild(phonetic)
        }
        section.appendChild(head)
      }

      const content = document.createElement('div')
      content.className = 'mydict-entry-body'
      // 先在惰性的 <template> 里解析：资源 URL 改写好之前，节点一旦入 DOM 浏览器就开始取，
      // 根相对路径会打到当前网页的 origin 上
      const template = document.createElement('template')
      template.innerHTML = sanitizeDictionaryHtml(item.definition ?? '')
      absolutizeResourceRefs(template.content, baseUrl)
      content.appendChild(template.content)
      section.appendChild(content)

      body.appendChild(section)
    })

    if (audioEnabled) {
      wireDictAudio(
        body,
        (resourcePath) => resourcePath, // 资源已在 absolutizeResourceRefs 里变成绝对地址
        {
          // 反馈走面板级 toast，而不是每组词条各造一个提示条：文档级发音委派只有一个
          // 「当前播放入口」，提示条挂在某一组里时，失败信息可能落进折叠的组、用户看不到
          // （真机「无声也无提示」正是这个由来）。
          onStart: () => onNotify?.('ok', '🔊 播放中…'),
          onFail: (message) => onNotify?.('error', `发音失败：${message}`),
          onSuccess: () => {},
        },
        // 页面上下文（划词面板）里的发音兜底通道：background 取字节 → Web Audio / data URL
        options.sendBackground,
      )
    }

    wireLinks(body, onNavigate)
    // 词条图片交互：捕获阶段按容器分流（牛津拓展图的展开/收起、大图幻灯片）
    wireImageInteractions(body, options.openImages)
    if (isDarkMode) adaptToDarkTheme(body)

    const visible = activeLang === '' || group.lang === activeLang
    details.style.display = visible ? '' : 'none'
    details.open = visible && !openedVisibleGroup
    if (visible) openedVisibleGroup = true
    scopes.push({ details, lang: group.lang })
  }

  // ---------------------------------------------------------- 键盘导航（↑/↓ 切词条、←/→ 切语言）

  /** 切换语言标签（点击标签页与 ←/→ 共用）：更新激活态、过滤分组，并展开第一个可见分组。 */
  function selectLang(value) {
    activeLang = value
    for (const { value: v, tab } of tabButtons) {
      tab.classList.toggle('mydict-lang-tab-active', v === value)
    }
    applyLangFilter(value)
    if (translateBlock && value === TRANSLATE_TAB) {
      // 翻译请求懒加载：第一次切到这个标签才发（开场即翻译标签的场景已在创建时发过）
      if (!translateBlock.loaded) {
        translateBlock.loaded = true
        void translateBlock.load()
      }
      translateBlock.scrollIntoView({ block: 'nearest' })
      return
    }
    if (onlineBlock && value === ONLINE_TAB) {
      if (!onlineBlock.loaded) {
        onlineBlock.loaded = true
        void onlineBlock.load()
      }
      onlineBlock.scrollIntoView({ block: 'nearest' })
      return
    }
    if (randomBlock && value === RANDOM_TAB) {
      // 首次点进来才去挑一条（已经挑过就直接展示，换词用面板里的「换一个 →」）
      if (!randomBlock.loaded) {
        randomBlock.loaded = true
        random.onNext?.()
      }
      randomBlock.scrollIntoView({ block: 'nearest' })
      return
    }
    const first = scopes.find((s) => s.details.style.display !== 'none')
    if (first) {
      first.details.open = true
      first.details.scrollIntoView({ block: 'nearest' })
    }
  }

  /**
   * ↑/↓：在**当前语言下可见**的分组间切换——关掉当前展开的那组、打开相邻的一组，
   * 到头了绕回（与查询页 ←/→ 切词典的行为一致），并把它滚进可视区。
   */
  function moveGroup(delta) {
    const visible = scopes.filter((s) => s.details.style.display !== 'none')
    if (visible.length === 0) return
    let current = visible.findIndex((s) => s.details.open)
    if (current < 0) current = 0
    const next = (current + delta + visible.length) % visible.length
    if (next === current) return
    visible[current].details.open = false
    visible[next].details.open = true
    visible[next].details.scrollIntoView({ block: 'nearest' })
  }

  /**
   * ←/→：切到上一个/下一个标签（循环）。顺序 = 语言标签 → 「翻译」标签（在最右），
   * 「全部」不参与循环（它只是点击用的重置位）；只有一种语言且无翻译标签时无事可做。
   */
  function moveLang(delta) {
    const navOrder = tabButtons.filter((t) => t.value !== '').map((t) => t.value)
    if (navOrder.length < 2) return
    const current = navOrder.indexOf(activeLang)
    const next = (current + delta + navOrder.length) % navOrder.length
    selectLang(navOrder[next])
  }

  return { moveGroup, moveLang }
}
