/**
 * 消息路由：content / options → background 的唯一入口。
 *
 * 查询在这里做**候选词循环**：`buildLookupCandidates` 给出有序变体，逐个查、命中即停。
 * 顺序有意义（精确优先于词形还原），所以不能并行发出去取第一个回来的。
 */

import { CODE, MSG, fail, ok } from '../core/protocol.js'
import { buildLookupCandidates } from '../core/lookup-candidates.js'
import { edgeTranslate } from '../core/translator.js'
import { getSettings } from '../core/settings.js'
import { createCache } from './cache.js'
import * as client from './mydict-client.js'

const cache = createCache()

const queryKey = (base, word) => `query:${base}:${word}`
const vocabKey = (base, word) => `vocab:${base}:${word}`

/** 统一把异常收敛成 {ok:false, code, message}。 */
function toFailure(error) {
  if (error && typeof error.code === 'string') {
    return fail(error.code, error.message)
  }
  return fail(CODE.ERROR, error?.message || String(error))
}

/**
 * 查词：按候选顺序找到第一个有结果的词。
 * 返回命中词 `hitWord`，面板 header 会在原文与命中词不同时显示归一化过程。
 */
async function handleQuery(settings, { word, lang } = {}) {
  const candidates = buildLookupCandidates(word, lang)
  if (candidates.length === 0) {
    return fail(CODE.EMPTY, '这不是一个可查询的词')
  }

  const base = settings?.baseUrl || ''
  for (const candidate of candidates) {
    const key = queryKey(base, candidate)
    let results = cache.get(key)
    if (results === undefined) {
      const payload = await client.query(settings, candidate)
      results = payload?.results || []
      cache.set(key, results)
    }
    if (results.length > 0) {
      return ok({ results, hitWord: candidate, candidates })
    }
  }
  return fail(CODE.EMPTY, '没有词典收录这个词')
}

/**
 * 随机浏览：先向服务端要一条随机词条（`/api/dict/random`），再用**同一条查词管线**
 * 取回它的词条 HTML（`/api/v1/query?full_style=true`）——这样渲染层完全不用改。
 * 结果收敛到「这条随机词条所属的那部词典」，避免退化成一次普通的多词典查询。
 */
async function handleRandom(settings, { dictIds } = {}) {
  const pick = await client.random(settings, dictIds)
  if (!pick?.word) return fail(CODE.EMPTY, '服务端没有返回随机词条')
  const payload = await client.query(settings, pick.word)
  const all = payload?.results || []
  const sameDict = all.filter((item) => item.dictionary_id === pick.dictionary_id)
  const results = sameDict.length > 0 ? sameDict : all
  if (results.length === 0) {
    return fail(CODE.EMPTY, `随机挑到「${pick.word}」，但没查到词条`)
  }
  return ok({ results, hitWord: pick.word, random: pick })
}

async function handleVocabList(settings, { word } = {}) {
  const base = settings?.baseUrl || ''
  const key = vocabKey(base, word)
  const cached = cache.get(key)
  if (cached !== undefined) return ok(cached)

  const data = await client.vocabList(settings, word)
  cache.set(key, data, 30 * 1000)
  return ok(data)
}

async function handleVocabAdd(settings, { word, dictionaryId } = {}) {
  const data = await client.vocabAdd(settings, word, dictionaryId)
  // 变更后立刻失效，避免面板里再打开还是旧状态
  cache.deleteByPrefix(`vocab:${settings?.baseUrl || ''}:`)
  return ok(data)
}

async function handleVocabRemove(settings, { itemId } = {}) {
  const data = await client.vocabRemove(settings, itemId)
  cache.deleteByPrefix(`vocab:${settings?.baseUrl || ''}:`)
  return ok(data)
}

/**
 * 翻译兜底：content script 直连 edge 端点被页面 CSP 拦掉时走这条通道。
 * 正常情况下请求根本不会到这里（见 core/translator.js 的注释）。
 */
async function handleTranslate({ texts, from, to } = {}) {
  if (!Array.isArray(texts) || texts.length === 0 || typeof to !== 'string' || !to) {
    return fail(CODE.ERROR, '翻译参数不完整')
  }
  const trimmed = texts.map((t) => String(t ?? '').trim()).filter(Boolean)
  if (trimmed.length === 0) return ok([])
  return ok(await edgeTranslate(trimmed, { from, to }))
}

/**
 * 消息入口。所有 handler 都是「拿最新设置 → 干活 → 收敛错误」的同一形状。
 * 返回值一定是 {ok:true,...} 或 {ok:false,...}，绝不抛出去（抛出去 content 只能看到
 * 一个没有信息量的 "message port closed"）。
 */
export async function route(message) {
  const type = message?.type
  try {
    // 这条不需要设置，也不用读 storage，先处理掉
    if (type === MSG.OPEN_OPTIONS) {
      chrome.runtime.openOptionsPage()
      return ok({})
    }
    // 翻译兜底同样不需要 MyDict 设置（Edge 接口与 MyDict 无关）
    if (type === MSG.TRANSLATE) {
      return await handleTranslate(message?.payload)
    }

    const settings = await getSettings()
    const payload = message?.payload || {}

    switch (type) {
      case MSG.QUERY:
        return await handleQuery(settings, payload)
      case MSG.RANDOM:
        return await handleRandom(settings, payload)
      case MSG.ONLINE_LOOKUP:
        return ok(await client.onlineLookup(settings, payload))
      case MSG.AUDIO_FETCH:
        // 发音兜底：不需要 MyDict 设置（URL 已由 content 侧解析成绝对地址）
        return ok(await client.audioFetch(payload?.url))
      case MSG.VOCAB_LIST:
        return await handleVocabList(settings, payload)
      case MSG.VOCAB_ADD:
        return await handleVocabAdd(settings, payload)
      case MSG.VOCAB_REMOVE:
        return await handleVocabRemove(settings, payload)
      case MSG.TEST_CONNECTION:
        return ok(await client.testConnection(settings))
      default:
        return fail(CODE.ERROR, `未知消息类型：${type}`)
    }
  } catch (error) {
    return toFailure(error)
  }
}

/** 地址/Token 变了就清缓存（由 background.js 的 storage 监听调用）。 */
export function resetCache() {
  cache.clear()
}
