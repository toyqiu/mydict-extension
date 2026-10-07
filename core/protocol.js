/**
 * content ⇄ background 的消息契约。两侧共用，改这里就是改协议。
 *
 * 统一形状：
 *   请求  { type, payload? }
 *   响应  { ok: true, data } | { ok: false, code, message }
 *
 * 所有失败都收敛成下面这组 code，UI 只认 code、不解析文案。
 */

export const MSG = {
  /** {word, lang?} -> {results, hitWord, candidates} 按候选词依次查，命中即停 */
  QUERY: 'QUERY',
  /**
   * {dictIds?} -> {results, hitWord, random} 随机浏览：服务端挑一条随机词条
   * （`/api/dict/random`），再走同一条查词管线取回它的词条 HTML。
   */
  RANDOM: 'RANDOM',
  /**
   * {word, lang} -> {word, lang, sections, links} 在线词典聚合（Wikipedia/Wiktionary/百度百科）。
   * 无 CORS 头，必须 background 发；服务端总开关关着时返回 UNSUPPORTED。
   */
  ONLINE_LOOKUP: 'ONLINE_LOOKUP',
  /** {word} -> {saved: {[dictionaryId]: itemId}} 该词在生词本里的记录 */
  VOCAB_LIST: 'VOCAB_LIST',
  /** {word, dictionaryId} -> {itemId} 409 时返回 DUPLICATE */
  VOCAB_ADD: 'VOCAB_ADD',
  /** {itemId} -> {} */
  VOCAB_REMOVE: 'VOCAB_REMOVE',
  /** 设置页用：探一次真实查询，回报连通性与耗时 */
  TEST_CONNECTION: 'TEST_CONNECTION',
  /** background → content：外部触发查词（右键菜单）。不走 request/response。 */
  TRIGGER: 'TRIGGER',
  /** content → background：打开设置页（面板里的「打开设置」按钮）。 */
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  /** popup → content：探针，确认当前页面的 content script 是否注入。 */
  PING: 'PING',
  /**
   * content/popup → background：翻译兜底通道。content script 直连 edge 端点被页面
   * CSP 拦掉时才走这里（background 的 fetch 不受页面 CSP 约束）。
   * {texts: string[], from?, to?} -> string[]
   */
  TRANSLATE: 'TRANSLATE',
  /**
   * content → background：发音兜底通道。页面上下文里 <audio> 直连 MyDict 的 mp3 可能被
   * 页面 CSP(media-src)/跨站媒体策略/网络 shields 拦掉（弹窗是扩展页面不受限），background
   * 取回字节转 data URL 后在页面里播。{url} -> {dataUrl, mime}
   */
  AUDIO_FETCH: 'AUDIO_FETCH',
}

export const CODE = {
  /** 还没填地址/Token */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** 地址填了，但没授予该 origin 的 host 权限 */
  PERMISSION_MISSING: 'PERMISSION_MISSING',
  /** 401/403：Token 不对或过期 */
  AUTH: 'AUTH',
  /** 词条存在但没内容（词典没这个词） */
  EMPTY: 'EMPTY',
  /** 服务端明确说不支持（当前 mydict 不会返回，留给将来） */
  UNSUPPORTED: 'UNSUPPORTED',
  /** 409：这个词在这部词典下已经收藏过了 */
  DUPLICATE: 'DUPLICATE',
  /** 网络层失败（DNS/连接被拒/TLS） */
  NETWORK: 'NETWORK',
  /** 超时 */
  TIMEOUT: 'TIMEOUT',
  /** 其它服务端错误（带 HTTP 状态码） */
  SERVER: 'SERVER',
  /** 兜底 */
  ERROR: 'ERROR',
}

/** 查询超时（毫秒）。实测一次 36 部词典的查询约 0.12s，给足余量。 */
export const QUERY_TIMEOUT_MS = 15000

/** 生词本接口超时（毫秒）。 */
export const VOCAB_TIMEOUT_MS = 10000

export const ok = (data) => ({ ok: true, data })
export const fail = (code, message) => ({ ok: false, code, message: message || code })

/**
 * 把任意异常/HTTP 状态收敛成 CODE。
 * 判断顺序有意为之：AUTH 先于 SERVER，避免 401 被当成普通服务端错误。
 */
export function codeFromStatus(status) {
  if (status === 401 || status === 403) return CODE.AUTH
  if (status === 409) return CODE.DUPLICATE
  if (status === 404) return CODE.EMPTY
  if (status >= 500) return CODE.SERVER
  return CODE.ERROR
}
