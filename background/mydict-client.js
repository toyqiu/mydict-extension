/**
 * MyDict 的 HTTP 客户端。**只在 service worker 里跑**。
 *
 * 为什么必须放这儿：`/api/v1/query` 不返回任何 CORS 头，content script 的请求带的是页面
 * 的 origin，会被浏览器拦掉。service worker 有 host 权限，跨域请求不受 CORS 限制。
 * 词典资源（/dict-res/）反而是公开只读的，那边直接绝对地址加载，不经过这里。
 */

import {
  CODE,
  QUERY_TIMEOUT_MS,
  VOCAB_TIMEOUT_MS,
  codeFromStatus,
} from '../core/protocol.js'
import {
  buildQueryUrl,
  buildRandomUrl,
  buildVocabItemUrl,
  buildVocabListUrl,
  buildVocabUrl,
  buildOnlineLookupUrl,
  normalizeBase,
  originPattern,
} from '../core/mydict-url.js'

/** 带 code 的错误，router 直接取 code 回给 content。status 保留原始 HTTP 状态码。 */
export class MydictError extends Error {
  constructor(code, message, status) {
    super(message || code)
    this.code = code
    this.status = status
  }
}

/** 读设置并校验「配了地址、且拿到了该 origin 的 host 权限」。 */
async function ensureReady(settings) {
  const base = normalizeBase(settings?.baseUrl)
  if (!base) {
    throw new MydictError(CODE.NOT_CONFIGURED, '还没配置 MyDict 地址')
  }
  // Firefox MV3 的 host 权限是可选的，没授权时 fetch 会直接抛 NetworkError，
  // 被归成「连不上服务器」，用户会白查半天网络。这里先查一次，报成可行动的
  // PERMISSION_MISSING；Chrome 里 host_permissions 安装即授予，contains 恒真。
  if (chrome.permissions?.contains) {
    const granted = await chrome.permissions.contains({
      origins: [originPattern(base)],
    })
    if (!granted) {
      throw new MydictError(
        CODE.PERMISSION_MISSING,
        `还没授权访问 ${new URL(base).origin}，到设置页点「保存」授权一次`,
      )
    }
  }
  // token 允许为空：mydict 可以开匿名查询。但生词本一定要 token，由服务端 401 兜住。
  return { base, token: (settings?.token || '').trim() }
}

/**
 * 发一个请求并解析 JSON。
 *
 * 超时用 AbortController 自己做，而不是只依赖 fetch 的 signal——SW 被回收时挂起的
 * fetch 会直接断掉，显式超时能给出可读的错误码。
 */
async function requestJson(url, { method = 'GET', token, body, timeoutMs } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)

  let response
  try {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      // 不带 cookie：MyDict 用 Bearer token 鉴权，带上第三方 cookie 只是徒增暴露面
      credentials: 'omit',
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new MydictError(CODE.TIMEOUT, `请求超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw new MydictError(CODE.NETWORK, `连不上服务器：${error?.message || error}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const payload = await response.json()
      detail = payload?.message || payload?.detail || ''
    } catch {
      /* 非 JSON 错误体，忽略 */
    }
    const code = codeFromStatus(response.status)
    throw new MydictError(code, detail || `HTTP ${response.status}`, response.status)
  }

  try {
    return await response.json()
  } catch {
    throw new MydictError(CODE.SERVER, '服务器返回的不是合法 JSON')
  }
}

/** 取回音频字节转 data URL（发音兜底通道用）。上限 10MB，超了直接拒。 */
export async function audioFetch(url) {
  const target = new URL(url)
  if (!/^https?:$/.test(target.protocol)) {
    throw new MydictError(CODE.ERROR, '只支持 http(s) 音频地址')
  }
  const response = await fetch(target, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) {
    throw new MydictError(codeFromStatus(response.status), `HTTP ${response.status}`, response.status)
  }
  const mime = (response.headers.get('content-type') ?? 'audio/mpeg').split(';')[0].trim()
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > 10 * 1024 * 1024) {
    throw new MydictError(CODE.ERROR, '音频文件超过 10MB，不再中转')
  }
  // 分块转 base64：一次性 String.fromCharCode 在大文件上会爆栈
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return { dataUrl: `data:${mime};base64,${btoa(binary)}`, mime }
}

/** 查一个词，返回服务端原始 `{results}`。 */
export async function query(settings, word) {
  const { base, token } = await ensureReady(settings)
  return requestJson(buildQueryUrl(base, word), { token, timeoutMs: QUERY_TIMEOUT_MS })
}

/**
 * 随机挑一条词条，返回 `{dictionary_id, dictionary_name, word, entry_id}`。
 *
 * 走 `/api/dict/random`（服务端没有 v1 版随机接口）。该端点校验网页会话 JWT、
 * **不认 sk- API Token**，所以这里不带 Token——服务端开「开放使用」时匿名可用；
 * 没开则 401，翻成可行动的 UNSUPPORTED（与在线词典那条路的处理一致）。
 */
export async function random(settings, dictIds) {
  const { base } = await ensureReady(settings)
  try {
    return await requestJson(buildRandomUrl(base, dictIds), { timeoutMs: QUERY_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof MydictError && error.status === 401) {
      throw new MydictError(
        CODE.UNSUPPORTED,
        '随机浏览需要 MyDict 开启「开放使用」（管理后台 → 系统设置）',
        401,
      )
    }
    throw error
  }
}

/**
 * 在线词典聚合（Wikipedia / Wiktionary / 百度百科 + 外部搜索链接）。
 *
 * 与 /api/v1/query 一样无 CORS 头，只能在 background 发。服务端有自己的限流与
 * 600s 缓存。错误语义与鉴权要分清（真机踩过的三层坑）：
 *   - 403 = 功能未开启（online_dict_enabled）→ UNSUPPORTED「未开启」
 *   - 401 且带了 Token → **该端点校验的是网页会话 JWT，不认 sk- API Token**，
 *     带 sk- Token 必然 401。降级为匿名重试一次（服务端开启「开放使用」时匿名可用）。
 *   - 匿名仍 401 = 服务端没开「开放使用」，扩展侧无法使用 → UNSUPPORTED 说明。
 */
export async function onlineLookup(settings, { word, lang }) {
  const { base, token } = await ensureReady(settings)
  const url = buildOnlineLookupUrl(base, word, lang)
  try {
    return await requestJson(url, { token, timeoutMs: QUERY_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof MydictError && error.status === 403) {
      throw new MydictError(CODE.UNSUPPORTED, '在线词典未开启（MyDict 管理后台 → 系统设置）', 403)
    }
    if (error instanceof MydictError && error.status === 401 && token) {
      try {
        return await requestJson(url, { token: '', timeoutMs: QUERY_TIMEOUT_MS })
      } catch (retryError) {
        if (retryError instanceof MydictError && retryError.status === 401) {
          throw new MydictError(
            CODE.UNSUPPORTED,
            '在线词典需要网页登录或服务端开启「开放使用」，当前配置无法使用',
            401,
          )
        }
        throw retryError
      }
    }
    throw error
  }
}

/** 该词在生词本里的记录，返回 `{ [dictionaryId]: itemId }`。 */
export async function vocabList(settings, word) {
  const { base, token } = await ensureReady(settings)
  if (!token) throw new MydictError(CODE.AUTH, '生词本需要 Token')
  const payload = await requestJson(buildVocabListUrl(base, word), {
    token,
    timeoutMs: VOCAB_TIMEOUT_MS,
  })
  const saved = {}
  for (const item of payload?.items || []) {
    // 服务端是模糊搜索，可能返回一堆「包含该词」的记录；只认词头完全一致的
    if (item.word !== word) continue
    if (item.dictionary_id === null || item.dictionary_id === undefined) continue
    saved[item.dictionary_id] = item.id
  }
  return { saved }
}

/** 收藏。返回新建记录的 id。重复收藏时抛 DUPLICATE。 */
export async function vocabAdd(settings, word, dictionaryId) {
  const { base, token } = await ensureReady(settings)
  if (!token) throw new MydictError(CODE.AUTH, '生词本需要 Token')
  const payload = await requestJson(buildVocabUrl(base), {
    method: 'POST',
    token,
    body: { word, dictionary_id: dictionaryId },
    timeoutMs: VOCAB_TIMEOUT_MS,
  })
  return { itemId: payload?.id ?? null }
}

/** 按记录 id 删除。 */
export async function vocabRemove(settings, itemId) {
  const { base, token } = await ensureReady(settings)
  if (!token) throw new MydictError(CODE.AUTH, '生词本需要 Token')
  await requestJson(buildVocabItemUrl(base, itemId), {
    method: 'DELETE',
    token,
    timeoutMs: VOCAB_TIMEOUT_MS,
  })
  return {}
}

/** 探针词：几乎所有词典集都收，用来验证「连通 + 鉴权 + 真的能查出东西」。 */
const PROBE_WORD = 'test'

/**
 * 设置页的「测试连接」。
 *
 * 注意：即使命中 0 部词典也算连通成功——说明地址/权限/鉴权都对，只是这套词典里没这个词。
 * 这一点要在返回里区分开，否则用户会以为配置错了。
 */
export async function testConnection(settings) {
  const { base, token } = await ensureReady(settings)
  const started = performance.now()
  const payload = await requestJson(buildQueryUrl(base, PROBE_WORD), {
    token,
    timeoutMs: QUERY_TIMEOUT_MS,
  })
  const elapsedMs = Math.round(performance.now() - started)
  const results = payload?.results || []
  return {
    elapsedMs,
    probeWord: PROBE_WORD,
    resultCount: results.length,
    dictionaryCount: new Set(results.map((item) => item.dictionary_id)).size,
    hasToken: Boolean(token),
  }
}
