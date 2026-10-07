/**
 * MyDict 的 URL 构造 —— 全项目只在这里拼参数。
 *
 * 与阅读器（MyReader）的差别：那边网页版要把资源绕经同源中继（HTTPS 页面加载局域网
 * HTTP 资源会被 mixed content 拦掉），后端 Tauri 版才是直连。**扩展属于后者**——
 * 扩展自己的 HTTPS 入口（lucky 反代）实测可用，且 `/dict-res/` 带
 * `Access-Control-Allow-Origin: *`、不校验 token，所以资源直接用绝对地址最省事，
 * 而且词典 CSS 里的相对 `url(…)` 也能自然解析正确。
 */

/** 资源路径前缀。词典词条里引用自己资源时用的就是它。 */
export const DICT_RES_PREFIX = '/dict-res/'

/**
 * 归一化用户填的服务器地址：去空白、去尾部斜杠，并剥掉可能已经带上的
 * `/api/v1/query` 或 `/api/v1/vocab`（两种写法都接受，用户很可能是从浏览器地址栏抄的）。
 */
export function normalizeBase(raw) {
  return (raw ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1\/(?:query|vocab)$/, '')
}

/** `<base>/api/v1/query?word=&full_style=true&all_langs=true` */
export function buildQueryUrl(base, word) {
  const url = new URL(`${normalizeBase(base)}/api/v1/query`)
  url.searchParams.set('word', word)
  // full_style=true 要原始 HTML（默认会被服务端剥成纯文本）
  url.searchParams.set('full_style', 'true')
  // 中日共用汉字，按单一优先语言路由会让另一半词典整体消失（日文书里查「政府」看不到中文词典）
  url.searchParams.set('all_langs', 'true')
  return url.toString()
}

/**
 * `<base>/api/dict/random[?dict_ids=1,2]` —— 随机挑一条词条。
 *
 * 注意走的是**网页前台接口**（`/api/dict/*`），服务端没有 `/api/v1/` 版随机接口。
 * 该接口校验网页会话 JWT、**不认 sk- API Token**；服务端开「开放使用」时匿名可用，
 * 所以扩展侧一律不带 Token（带了反而必然 401）。
 */
export function buildRandomUrl(base, dictIds) {
  const url = new URL(`${normalizeBase(base)}/api/dict/random`)
  if (Array.isArray(dictIds) && dictIds.length > 0) {
    url.searchParams.set('dict_ids', dictIds.join(','))
  }
  return url.toString()
}

/**
 * `<base>/api/dict/online/lookup?word=&lang=` —— 服务端聚合的在线词典
 * （Wikipedia / Wiktionary / 百度百科 + 外部搜索链接）。
 *
 * lang 是 2 字母码（zh/ja/en…，服务端正则 `^[a-z]{2}(-[A-Za-z]{2,4})?$`）。
 * 无 CORS 头，和 /api/v1/query 一样只能在 background 发。
 */
export function buildOnlineLookupUrl(base, word, lang) {
  const url = new URL(`${normalizeBase(base)}/api/dict/online/lookup`)
  url.searchParams.set('word', word)
  url.searchParams.set('lang', lang)
  return url.toString()
}

/** `<base>/api/v1/vocab`
 *
 * 服务端自己查词条并快照音标/释义，所以客户端只发词 + 来源词典 id。
 */
export function buildVocabUrl(base) {
  return `${normalizeBase(base)}/api/v1/vocab`
}

/** `<base>/api/v1/vocab?search=<词>&page_size=<n>` —— 取某个词在生词本里的记录。 */
export function buildVocabListUrl(base, word, pageSize = 50) {
  const url = new URL(buildVocabUrl(base))
  url.searchParams.set('search', word)
  url.searchParams.set('page_size', String(pageSize))
  return url.toString()
}

/** `<base>/api/v1/vocab/<id>` —— 删除某条记录。 */
export function buildVocabItemUrl(base, itemId) {
  return `${buildVocabUrl(base)}/${encodeURIComponent(String(itemId))}`
}

/** 判断一个引用是不是词典资源（只有这种才需要改写成绝对地址）。 */
export function isDictResPath(raw) {
  return typeof raw === 'string' && raw.startsWith(DICT_RES_PREFIX)
}

/**
 * 把词条里的 `/dict-res/…` 引用改写成可被页面加载的绝对地址。
 *
 * 两道幂等守卫（参考实现里都真实发生过）：
 *  - 已经是 http(s) 绝对地址的原样返回，不能重复拼接；
 *  - 不以 `/dict-res/` 开头的（外链、data:、锚点）原样返回。
 */
export function buildResourceUrl(base, raw) {
  if (!isDictResPath(raw)) return raw
  return `${normalizeBase(base)}${raw}`
}

/** 地址是否是个能用的 http(s) URL。设置页保存前校验用。 */
export function isValidBase(raw) {
  try {
    const url = new URL(normalizeBase(raw))
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 给 `chrome.permissions.request` 用的 origin 匹配串：`https://host:port/*`。
 *
 * Chrome MV3 里 host_permissions 已安装即授予，request 会静默通过；
 * Firefox MV3 的 host 权限是可选的，必须经 request（用户手势）授予，
 * 否则 background 的跨域 fetch 与 content script 都不会生效。
 */
export function originPattern(base) {
  const url = new URL(normalizeBase(base))
  return `${url.origin}/*`
}
