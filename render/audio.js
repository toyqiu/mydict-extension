/**
 * 发音播放：把词条里的发音点击变成内联播放。移植自 MyReader `dictAudio.ts`。
 *
 * 词条里的发音有两种形态：
 *   - 千篇系：`<a data-mp3="https://…mp3">`，原本靠词典自带脚本播（词条脚本在这里不执行）
 *   - NHK 发音词典等：`<a href="/dict-res/N/res/SPX/x.spx">`（`sound://` 改写产物）
 *
 * **为什么用全页共用的一个 <audio> 而不是每次 new Audio()**：`new Audio()` 造出来的元素
 * 没有被任何变量引用、也不在 DOM 里，点击处理函数一返回它就可能被 GC 回收——播放到一半
 * 就断了，表象正是「点了没声音」。挂在 documentElement 上留一个引用（MyReader 同款做法），
 * 同时也保证同时只有一个声音在放。
 *
 * 播放策略（按顺序）：
 *   1. 直连候选：`.spx` 先试同名 `.mp3`/`.opus`（mydict 对 `.mp3` 请求有同名 `.spx` 兜底，
 *      而 SPX 目录通常本来就有真 mp3），都不行才试本体。
 *   2. 页面上下文（划词面板）里，直连 `<audio>` 可能被页面 CSP 的 `media-src` / 跨站媒体
 *      策略 / 浏览器 shields 拦掉——此时经 background 取回字节，用 **Web Audio 解码播放**
 *      （AudioContext 不走媒体元素加载，`media-src` 管不到它），再退一步才用 data: URL 的
 *      `<audio>`。扩展页面（弹窗/lightbox 页）直连从不失败，永不进入这一层。
 *
 * 触屏：部分安卓内核在触摸序列里吞掉合成 click，只挂 click 的发音点击会静默无反应
 * （v0.2.4 浮标同款问题）——pointerup(touch) 直接播放并压掉 500ms 内的合成 click；
 * 鼠标路径照旧走 click。
 *
 * 反馈：`hooks.onStart/onSuccess/onFail` 由 renderer 接到**面板级 toast**（而不是每组词条
 * 各造一个提示条）——文档级委派只有一个「当前播放入口」，提示条若挂在某一组里，失败信息
 * 可能落在折叠的组里、用户根本看不到（真机「无声也无提示」的由来）。
 */

/** 绑定标记：外链处理看到它就跳过，避免同一个发音点击被绑两次。 */
export const AUDIO_BOUND = 'dictAudioBound'

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|spx)(?:[?#].*)?$/i
const SPX_EXT_RE = /\.spx(?:[?#].*)?$/i

/** 单次候选的加载上限：网络/解码卡死时不能无限等，否则永远轮不到下一个候选、也不出提示。 */
const LOAD_TIMEOUT_MS = 5000

/** 全页共用的播放器。页面框架（SPA 换 body）可能把它摘掉，所以每次取的时候校验。 */
let sharedPlayer = null

function getPlayer() {
  if (sharedPlayer && sharedPlayer.isConnected) return sharedPlayer
  sharedPlayer = document.createElement('audio')
  sharedPlayer.dataset['dictPlayer'] = '1'
  // 不带 controls 本来就不渲染；display:none 再保险一层，免得被页面 CSS 拉出个占位
  sharedPlayer.style.display = 'none'
  ;(document.body || document.documentElement).appendChild(sharedPlayer)
  return sharedPlayer
}

/**
 * 候选回退链。
 *
 * .spx 优先试同名 .mp3 / .opus——服务端对 .mp3 请求会去找同名的 .spx，而 SPX 目录里
 * 常常本来就有一份真 mp3；两者都没有才回到 .spx 本体（这时只能靠 JS 解码，见文件头）。
 */
export function audioCandidates(url) {
  if (!SPX_EXT_RE.test(url)) return [url]
  const stem = url.replace(SPX_EXT_RE, '')
  return [`${stem}.mp3`, `${stem}.opus`, url]
}

/** play() 被自动播放策略拦下时置位，候选链走完后给出针对性的提示。 */
let blockedByPolicy = false

/** 最近一次媒体加载失败的细节（提示条的诊断依据）。 */
let lastMediaError = ''

/**
 * 共享 <audio> 的加载代际：换候选（重设 src）不会取消上一个资源的 error 事件——
 * 它是异步派发的，会在**下一个候选已经挂上监听之后**才到，把新候选当成失败者毒死
 * （真机表现：第一个候选失败后，后面所有候选无论好坏都报「音频加载失败」）。
 * 每次试播自增代际，error 处理器只认当前代际。
 */
let loadGeneration = 0

/** 试播一个地址。resolve(true)=真的开始放了；resolve(false)=这个地址不行，换下一个。 */
function tryPlay(audio, url) {
  const generation = ++loadGeneration
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      audio.removeEventListener('error', onError)
      resolve(value)
    }
    const onError = () => {
      if (generation !== loadGeneration) return // 陈旧加载的错误：已经在放别的候选了
      lastMediaError = audio.error?.message || ''
      finish(false)
    }

    timer = setTimeout(() => {
      if (generation !== loadGeneration) return
      lastMediaError = lastMediaError || '音频加载超时'
      // 卡住的候选别再让它稍后突然出声，和后面的候选重叠
      try {
        audio.pause()
      } catch {
        /* 忽略 */
      }
      finish(false)
    }, LOAD_TIMEOUT_MS)

    audio.addEventListener('error', onError)
    audio.src = url
    audio.load()
    audio.play().then(
      () => {
        if (generation !== loadGeneration) return
        finish(true)
      },
      (error) => {
        if (generation !== loadGeneration) return
        if (error?.name === 'NotAllowedError') {
          // 手势丢了：自动播放策略拦的。换候选也一样会被拦，直接报出来。
          blockedByPolicy = true
        }
        lastMediaError = lastMediaError || error?.name || ''
        finish(false)
      },
    )
  })
}

/** 是否运行在网页上下文（划词面板）；扩展页面（弹窗/lightbox 页）false。 */
const isPageContext = () =>
  !location.protocol.startsWith('chrome-') && !location.protocol.startsWith('moz-')

/** 让 background 取回音频字节转 data URL（audioFetch 端见 background/mydict-client.js）。 */
async function fetchAudioData(url, sendBackground) {
  if (!sendBackground) throw new Error('没有后台中转通道')
  const result = await sendBackground({ type: 'AUDIO_FETCH', payload: { url } })
  if (!result?.ok) throw new Error(result?.message || '音频中转失败')
  return result.data.dataUrl
}

/**
 * Web Audio 播放：把 background 取回的字节解码后直接送到扬声器。
 *
 * 这是页面上下文里最可靠的一条路——`media-src` CSP 管的是媒体**元素/资源的加载**，
 * 管不到 AudioContext 的输出；跨站媒体策略同理。解码失败（如 Speex）会抛错，由调用方
 * 退回 data: URL 的 <audio>。
 */
let sharedAudioContext = null
async function playViaWebAudio(dataUrl) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) throw new Error('浏览器不支持 Web Audio')
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('音频数据格式异常')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  if (!sharedAudioContext) sharedAudioContext = new Ctx()
  if (sharedAudioContext.state === 'suspended') await sharedAudioContext.resume()
  const buffer = await sharedAudioContext.decodeAudioData(bytes.buffer.slice(0))
  const source = sharedAudioContext.createBufferSource()
  source.buffer = buffer
  source.connect(sharedAudioContext.destination)
  source.start(0)
  return true
}

/**
 * @param {string} url 解析成绝对地址的发音资源
 * @param {{onStart?:Function, onSuccess?:Function, onFail?:Function}} hooks
 * @param {(message: object) => Promise} [sendBackground]
 */
async function playChain(url, hooks, sendBackground) {
  const { onStart, onSuccess, onFail } = hooks || {}
  onStart?.()
  const audio = getPlayer()
  blockedByPolicy = false
  lastMediaError = ''
  let lastError = ''

  // 1) 直连候选（桌面端与扩展页面基本都在这一步命中）
  for (const candidate of audioCandidates(url)) {
    const played = await tryPlay(audio, candidate)
    if (played) {
      onSuccess?.()
      return
    }
    lastError = lastMediaError || lastError
    if (blockedByPolicy) break
  }

  // 2) 页面上下文的兜底：background 取字节 → Web Audio 解码播放 → data: URL 媒体元素
  if (!blockedByPolicy && isPageContext() && sendBackground) {
    try {
      const dataUrl = await fetchAudioData(url, sendBackground)
      try {
        await playViaWebAudio(dataUrl)
        onSuccess?.()
        return
      } catch (error) {
        lastError = lastError || (error?.message ? `Web Audio：${error.message}` : '')
      }
      const played = await tryPlay(audio, dataUrl)
      if (played) {
        onSuccess?.()
        return
      }
      lastError = lastMediaError || lastError
    } catch (error) {
      lastError = lastError || (error instanceof Error ? error.message : String(error))
    }
  }

  onFail?.(
    blockedByPolicy
      ? '播放被浏览器拦截（没有点击手势），再点一次'
      : SPX_EXT_RE.test(url) && !lastError
        ? '这个 .spx 没有同名的 mp3，当前版本还解不了 Speex'
        : lastError || '音频加载失败',
  )
}

/** 最近一次 wiring 的播放入口（document 级委派用；多组词条共享同一套面板级 hooks）。 */
let activePlay = null

/** 防双播：元素级监听与 document 级委派可能同时命中同一次点击。 */
let recentlyPlayed = { src: '', at: 0 }

/**
 * document 捕获阶段的发音兜底（app.js 调用）。
 *
 * 真机场景：个别安卓内核对（面板 shadow 内的）词条元素不派发 pointerup/click——元素级
 * 监听永远收不到，点音标「完全没反应」。这里在 document 捕获阶段按 composedPath 找带发音
 * 标记的节点直接播放，事件只要到达页面任何位置就能截住；同一元素 600ms 内的重复触发被压掉。
 *
 * @param {Event} event
 * @returns {boolean} 是否已消费（调用方据此 preventDefault/stopPropagation）
 */
export function handleAudioTap(event) {
  if (!activePlay) return false
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue
    const marked = node.dataset?.[AUDIO_BOUND]
    const src = marked ? node.dataset['dictAudioSrc'] : ''
    if (!src) continue
    const now = Date.now()
    if (recentlyPlayed.src === src && now - recentlyPlayed.at < 600) return true
    recentlyPlayed = { src, at: now }
    activePlay(src)
    return true
  }
  return false
}

/**
 * 给单个发音元素绑 click + 触屏 pointerup 双通道。
 *
 * @param {HTMLElement} el
 * @param {() => string} getUrl
 * @param {(url: string) => void} play
 */
function bindPlay(el, getUrl, play) {
  el.dataset[AUDIO_BOUND] = '1'
  el.dataset['dictAudioSrc'] = getUrl()
  let touchPlayed = false
  el.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return
    // 阻止默认：既挡住锚点的导航兜底，也压掉内核的合成 mouse 事件序列
    event.preventDefault()
    touchPlayed = true
    play(getUrl())
    setTimeout(() => {
      touchPlayed = false
    }, 500)
  })
  el.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (touchPlayed) return
    play(getUrl())
  })
}

/**
 * 给子树里的发音锚点挂上内联播放。
 *
 * @param {HTMLElement} root
 * @param {(resourcePath: string) => string} resolve 把词条里的相对路径解析成可加载的绝对地址
 * @param {{onStart?:Function, onSuccess?:Function, onFail?:Function}} hooks 面板级反馈回调
 * @param {(message: object) => Promise} [sendBackground] 网页上下文里的发音兜底通道
 *   （renderer 传 chrome.runtime.sendMessage；弹窗是扩展页面，不需要）
 */
export function wireDictAudio(root, resolve, hooks, sendBackground) {
  const play = (url) => playChain(url, hooks, sendBackground)
  activePlay = play

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (!AUDIO_EXT_RE.test(href)) continue
    bindPlay(anchor, () => resolve(href), play)
  }

  // 千篇的发音按钮：url 在 data-mp3 上，href 是 "#" 或没有
  for (const el of root.querySelectorAll('[data-mp3]')) {
    const url = el.getAttribute('data-mp3') ?? ''
    if (!url) continue
    bindPlay(el, () => url, play)
  }
}
