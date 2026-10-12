const TOKEN = ENV_BOT_TOKEN
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const LIST_URL = ENV_LIST_URL // must return the raw JSON (raw.githubusercontent.com/...), not an HTML page
const WEBHOOK = '/endpoint'

const BOT_VERSION = '2026-10-12.1'
const EMBED_TIMEOUT_MS = 15000
const INLINE_CACHE_TIME = 60
const MAX_BODY_CHARS = 65536
const CRAWLER_UA = 'TelegramBot (like TwitterBot)'
// Master debug switch: verbose logging + chosen-event DM notifications
const DEBUG = false
function log (...args) {
  if (DEBUG) console.log(...args)
}

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname !== '/registerWebhook' && url.pathname !== '/unRegisterWebhook') {
    event.respondWith(new Response('No handler for this request', { status: 404 }))
  } else if (url.searchParams.get('key') !== SECRET || SECRET.length === 0) {
    event.respondWith(new Response('Forbidden', { status: 403 }))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else {
    event.respondWith(unRegisterWebhook(event))
  }
})

async function handleWebhook (event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await event.request.json()
  // Respond Ok immediately; processing continues after the response via waitUntil
  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

async function onUpdate (update) {
  try {
    console.log(`[v${BOT_VERSION}] update:`, Object.keys(update).join(','))
    if ('message' in update) {
      await onMessage(update.message)
    } else if ('inline_query' in update) {
      await onInlineQuery(update.inline_query)
    } else if ('chosen_inline_result' in update) {
      await onChosenInlineResult(update.chosen_inline_result)
    }
  } catch (e) {
    console.log('onUpdate error:', e.message || e)
  }
}

// Finds the first link in a text. Also accepts a bare domain ("tiktok.com/@x/video/1").
function extractUrl (text) {
  if (!text) return null
  const m = text.match(/https?:\/\/[^\s]+/i)
  if (m) return m[0]
  const t = text.trim()
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return 'https://' + t
  return null
}

function getTargets (entry) {
  return entry.targets || (entry.target ? [entry.target] : [])
}

// Direct message to the bot: replies with the link fixed by the first available target
async function onMessage (message) {
  const chatId = message.chat.id
  const isPrivate = message.chat.type === 'private'
  const link = extractUrl(message.text || message.caption || '')
  if (!link) {
    if (isPrivate) {
      await sendPlainText(chatId, 'Envie um link (TikTok, X/Twitter, Instagram, YouTube, Reddit, Bluesky) e eu devolvo o link com embed.')
    }
    return
  }
  const { url, title } = await getFixedURL(link)
  if (title === 'Embed Link') {
    if (isPrivate) {
      await sendPlainText(chatId, 'Nenhum provedor de embed disponível para esse link agora.')
    }
    return
  }
  return sendPlainText(chatId, url)
}

async function sendPlainText (chatId, text) {
  return (await fetch(apiUrl('sendMessage', {
    chat_id: chatId,
    text
  }))).json()
}

function originalKeyboard (url) {
  return { inline_keyboard: [[{ text: 'Original', url: url.toString() }]] }
}

// Placeholder for a query: original link formatted as a clickable platform name
async function buildPlaceholderContent (query, list) {
  const url = new URL(query)
  const matched = matchEntry(url, list || await fetchList())
  const label = matched ? matched.name : url.hostname
  return {
    text: `[${label}](${query})`,
    previewUrl: query
  }
}

// Inline mode: first option resolves automatically (first available target, edited after
// sending), followed by one option per target in list.json, which inserts that link directly.
async function onInlineQuery (inlineQuery) {
  const originalURL = extractUrl(inlineQuery.query)
  if (!originalURL) return answerInline(inlineQuery.id, [])

  const results = []
  try {
    const url = new URL(originalURL)
    const list = await fetchList()
    const matched = matchEntry(url, list)
    const targets = matched ? getTargets(matched) : []
    if (matched && targets.length) {
      const placeholder = await buildPlaceholderContent(originalURL, list)
      results.push({
        type: 'article',
        id: 'auto',
        title: `⚡ ${matched.name} · Automático`,
        description: 'Usa o primeiro provedor que estiver funcionando',
        input_message_content: {
          message_text: placeholder.text,
          parse_mode: 'markdown',
          link_preview_options: {
            is_disabled: false,
            url: placeholder.previewUrl
          }
        },
        // inline keyboard required: without it Telegram omits inline_message_id
        // in chosen_inline_result, making post-send editing impossible
        reply_markup: originalKeyboard(originalURL)
      })
      targets.forEach((target, i) => {
        const fixed = rewriteUrl(url, matched.source, target).toString()
        results.push({
          type: 'article',
          id: `t${i}`,
          title: `${matched.name} → ${target}`,
          description: fixed,
          input_message_content: { message_text: fixed }
        })
      })
    }
  } catch (e) {
    console.log('Inline: could not build options:', e.message || e)
  }

  if (!results.length) {
    // unsupported domain or list unavailable: still let the user send the original link
    results.push({
      type: 'article',
      id: 'original',
      title: 'Enviar link original',
      description: 'Nenhum provedor encontrado para este link',
      input_message_content: { message_text: originalURL }
    })
  }
  return answerInline(inlineQuery.id, results)
}

async function answerInline (inlineQueryId, results) {
  // Short Telegram-side cache: deduplicates rapid identical queries while keeping
  // list.json changes visible within a minute
  const r = await SendInlineQuery(inlineQueryId, JSON.stringify(results), {
    cache_time: results.length ? INLINE_CACHE_TIME : 1
  })
  console.log('answerInlineQuery:', JSON.stringify(r))
  return r
}

// Only the "auto" option is probed after sending and then edited to the winner. Failures
// are annotated onto the message: a fully untouched message means the click
// event never arrived (enable inline feedback via @BotFather /setinlinefeedback).
// When DEBUG is on, each chosen-event step is also DM'd to the clicking user
// Telegram memoizes link previews per exact URL - failed crawls included.
// Stamp a unique param so every edit forces an uncached crawl of the service.
function cacheBust (url) {
  const u = new URL(url)
  u.searchParams.set('_', Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  return u.toString()
}

async function notify (userId, text) {
  if (!DEBUG || !userId) return
  try {
    await sendPlainText(userId, text)
  } catch (e) {
    log('notify failed: ', e.message || e)
  }
}

async function onChosenInlineResult (chosen) {
  const userId = chosen.from && chosen.from.id
  await notify(userId, `📩 chosen received | result:${chosen.result_id} inline_message_id:${!!chosen.inline_message_id}`)
  // Target options already carry the final link; only "auto" needs resolving
  if (chosen.result_id !== 'auto') return
  const originalURL = extractUrl(chosen.query)
  if (!originalURL) return
  if (!chosen.inline_message_id) {
    await notify(userId, '⚠️ no inline_message_id - cannot edit')
    return
  }
  var base = { text: originalURL, previewUrl: null }
  try {
    const placeholder = await buildPlaceholderContent(originalURL)
    base = placeholder
    base.keyboard = originalKeyboard(originalURL)
  } catch (e) {
    log('Placeholder rebuild failed: ', e.message || e)
  }
  try {
    log('Chosen inline result: ', originalURL)
    const { url, title } = await getFixedURL(originalURL)
    if (!title || title === 'Embed Link') {
      await notify(userId, '⚠️ probe: no working embed service')
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ no working embed service right now`, base.previewUrl, base.keyboard)
      return
    }
    const freshUrl = cacheBust(url)
    const result = await editInlineMessage(chosen.inline_message_id, `[${title}](${freshUrl})`, freshUrl, base.keyboard)
    console.log('editMessageText:', JSON.stringify(result))
    await notify(userId, result.ok ? `✅ edited to ${url}` : `⚠️ edit rejected: ${result.description || 'unknown'}`)
    if (!result.ok) {
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ edit rejected: ${result.description || 'unknown'}`, base.previewUrl, base.keyboard)
    }
  } catch (e) {
    console.log('Failed to resolve/edit embed link:', e.message || e)
    await notify(userId, `💥 ${String(e.message || e).slice(0, 100)}`)
    try {
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ ${String(e.message || e).slice(0, 100)}`, base.previewUrl, base.keyboard)
    } catch (e2) {
      log('Annotation edit also failed: ', e2.message || e2)
    }
  }
}

async function editInlineMessage (inlineMessageId, text, url, replyMarkup) {
  const params = {
    inline_message_id: inlineMessageId,
    text,
    parse_mode: 'markdown',
    link_preview_options: JSON.stringify({
      is_disabled: false,
      url
    })
  }
  // omitting reply_markup strips the button from the edited message
  if (replyMarkup) params.reply_markup = JSON.stringify(replyMarkup)
  return (await fetch(apiUrl('editMessageText', params))).json()
}

// The provider list is read at runtime on every request, so changing list.json
// (and nothing else) is enough to switch providers - no redeploy needed.
async function fetchList () {
  const response = await fetch(LIST_URL)
  if (!response.ok) {
    throw new Error(`list.json fetch failed: ${response.status}`)
  }
  const text = await response.text()
  try {
    const json = JSON.parse(text)
    if (!Array.isArray(json)) throw new Error('not an array')
    return json
  } catch (e) {
    throw new Error(`ENV_LIST_URL did not return valid JSON (starts with: ${text.slice(0, 30).replace(/\s+/g, ' ')})`)
  }
}

function matchEntry (url, json) {
  var matched = null
  json.every(function (entry) {
    const regex = new RegExp(entry.source, 'gi')
    if (!regex.test(url.hostname)) {
      return true
    }
    log('Regex detected: ', entry.source)
    matched = entry
    return false
  })
  return matched
}

async function getFixedURL (originalURL) {
  log('Original URL: ', originalURL)
  var url = new URL(originalURL)
  const matched = matchEntry(url, await fetchList())
  var title = 'Embed Link'

  if (matched) {
    const candidates = getTargets(matched)
    const target = await selectTarget(url, matched.source, candidates)
    if (target) {
      log('Selected target: ', target)
      url = rewriteUrl(url, matched.source, target)
      title = matched.name
    } else {
      log('No working embed service, returning original URL')
    }
  }

  log('Fixed URL: ', url)
  return {
    url: url.toString(),
    title: title
  }
}

function rewriteUrl (url, sourceRegex, targetHost) {
  const rewritten = new URL(url.toString())
  rewritten.hostname = rewritten.hostname.replace(new RegExp(sourceRegex, 'gi'), targetHost)
  return rewritten
}

async function selectTarget (url, sourceRegex, candidates) {
  const probeUrls = new Map(candidates.map(candidate => [candidate, rewriteUrl(url, sourceRegex, candidate).toString()]))
  // Probe all candidates concurrently. A dead/slow target must never block the
  // rest: we resolve as soon as the highest-priority (list.json order) candidate
  // that passes either the direct-video or embed check is known and every
  // candidate of higher priority has settled. Service ranking stays driven by
  // list.json order, but an unreachable earlier target no longer prevents the
  // message from being edited with a working one.
  const settled = []
  const pending = new Set(candidates)
  return new Promise((resolve) => {
    if (candidates.length === 0) return resolve(null)
    candidates.forEach(candidate => {
      const probe = async () => {
        const probeUrl = probeUrls.get(candidate)
        const [direct, tags] = await Promise.all([
          probeDirectVideoFile(probeUrl),
          probeEmbed(probeUrl)
        ])
        return { candidate, direct: !!direct, tags: tags || { video: false, image: false } }
      }
      probe()
        .then(result => {
          settled.push(result)
          pending.delete(candidate)
          const winners = settled.filter(r => r.direct || r.tags.video)
          if (winners.length) {
            const best = winners.reduce((a, b) =>
              candidates.indexOf(a.candidate) <= candidates.indexOf(b.candidate) ? a : b)
            const bestIndex = candidates.indexOf(best.candidate)
            const higherPending = candidates.slice(0, bestIndex).some(c => pending.has(c))
            if (!higherPending) {
              log('Selected target: ', best.candidate)
              return resolve(best.candidate)
            }
          }
          if (pending.size === 0) {
            const imageWinner = settled.find(r => r.tags.image)
            if (imageWinner) {
              log('Image-only fallback: ', imageWinner.candidate)
              return resolve(imageWinner.candidate)
            }
            return resolve(null)
          }
        })
        .catch(() => {
          pending.delete(candidate)
          if (pending.size === 0) resolve(null)
        })
    })
  })
}

async function fetchWithTimeout (url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
  try {
    return await fetch(url, { redirect: 'follow', signal: controller.signal, ...options })
  } finally {
    clearTimeout(timeout)
  }
}

// 1-byte Range GET; a video/* final response is the deterministic embed signal
async function probeDirectVideoFile (url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': CRAWLER_UA,
        'Range': 'bytes=0-0'
      }
    })
    if (response.body) {
      response.body.cancel()
    }
    if (!response.ok) {
      log('Direct video file probe status: ', response.status)
      return false
    }
    const contentType = response.headers.get('content-type') || ''
    log('Direct video file probe content-type: ', contentType)
    return contentType.toLowerCase().startsWith('video/')
  } catch (e) {
    log('Direct video file probe failed: ', e.message || e)
    return false
  }
}

// Best effort: page must declare an og:video URL that resolves to a playable file
async function probeEmbed (probeUrl) {
  try {
    const response = await fetchWithTimeout(probeUrl, {
      method: 'GET',
      headers: { 'User-Agent': CRAWLER_UA }
    })
    if (!response.ok) {
      log('Probe HTTP status: ', response.status)
      return { video: false, image: false }
    }
    const contentType = response.headers.get('content-type') || ''
    if (contentType.toLowerCase().startsWith('video/')) {
      if (response.body) {
        response.body.cancel()
      }
      log('Embed URL is a direct video file: ', probeUrl)
      return { video: true, image: false }
    }
    if (!response.body) {
      return { video: false, image: false }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    var text = ''
    while (text.length < MAX_BODY_CHARS) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    reader.cancel()
    const tags = extractMetaTags(text)
    const videoUrl = tags['og:video'] || tags['og:video:url'] || tags['og:video:secure_url']
    const videoType = tags['og:video:type']
    const image = !!(tags['og:image'] || tags['og:image:url'] || tags['og:image:secure_url'])
    if (!videoUrl) {
      return { video: false, image }
    }
    if (videoType && !videoType.toLowerCase().startsWith('video/')) {
      log('og:video:type is not a video: ', videoType)
      return { video: false, image }
    }
    const video = await isPlayableVideo(videoUrl)
    log('Playable video check: ', videoUrl, video)
    return { video, image }
  } catch (e) {
    log('Probe failed: ', e.message || e)
    return { video: false, image: false }
  }
}

async function isPlayableVideo (videoUrl) {
  const contentType = await probeContentType(videoUrl)
  return !!contentType.toLowerCase().startsWith('video/')
}

async function probeContentType (url) {
  const contentTypeOf = (response) => response.headers.get('content-type') || ''
  try {
    const response = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { 'User-Agent': CRAWLER_UA }
    })
    if (response.status === 405 || response.status === 501) {
      throw new Error(`HEAD not supported: ${response.status}`)
    }
    return contentTypeOf(response)
  } catch (e) {
    log('HEAD probe failed, retrying with GET: ', e.message || e)
    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'User-Agent': CRAWLER_UA }
      })
      if (response.body) {
        response.body.cancel()
      }
      return contentTypeOf(response)
    } catch (e2) {
      log('GET probe failed: ', e2.message || e2)
      return ''
    }
  }
}

function extractMetaTags (html) {
  const tags = {}
  const metaRegex = /<meta\b[^>]*>/gi
  var m
  while ((m = metaRegex.exec(html)) !== null) {
    const tag = m[0]
    const getAttr = (name) => {
      const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
      return match ? match[1] : null
    }
    const property = getAttr('property') || getAttr('name')
    const content = getAttr('content')
    if (property && content) {
      tags[property.toLowerCase()] = content
    }
  }
  return tags
}

async function SendInlineQuery (inlineQueryId, results, extra = {}) {
  return (await fetch(apiUrl('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results,
    ...extra
  }))).json()
}

async function registerWebhook (event, requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    // explicit list: persisted restrictions would otherwise drop chosen_inline_result
    allowed_updates: JSON.stringify(['message', 'inline_query', 'chosen_inline_result'])
  }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}
