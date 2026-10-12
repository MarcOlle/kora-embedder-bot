const TOKEN = ENV_BOT_TOKEN
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const LIST_URL = ENV_LIST_URL // must return the raw JSON (raw.githubusercontent.com/...), not an HTML page
const WEBHOOK = '/endpoint'

const BOT_VERSION = '2026-10-12.3'
const EMBED_TIMEOUT_MS = 15000
const PICK_TIMEOUT_MS = 8000 // max wait for a working provider before giving up (or using an image-only one)
const INLINE_CACHE_TIME = 60
const MAX_BODY_CHARS = 65536
const CRAWLER_UA = 'TelegramBot (like TwitterBot)'
// Master debug switch: verbose logging
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

// Link from a message: plain text first, then hyperlinked text (common in forwarded posts)
function extractUrlFromMessage (message) {
  const text = message.text || message.caption || ''
  const fromText = extractUrl(text)
  if (fromText) return fromText
  const entities = message.entities || message.caption_entities || []
  for (const entity of entities) {
    if (entity.type === 'text_link' && entity.url) return entity.url
  }
  return null
}

function getTargets (entry) {
  return entry.targets || (entry.target ? [entry.target] : [])
}

// Direct message to the bot (typed or forwarded): replies with the link fixed by a
// fastest provider that is currently working.
async function onMessage (message) {
  const chatId = message.chat.id
  const isPrivate = message.chat.type === 'private'
  const link = extractUrlFromMessage(message)
  if (!link) {
    if (isPrivate) {
      await sendPlainText(chatId, 'Envie ou encaminhe um link (TikTok, X/Twitter, Instagram, YouTube, Reddit, Bluesky) e eu devolvo o link com embed.')
    }
    return
  }
  const { url, title, matched } = await getFixedURL(link)
  if (!matched) {
    if (isPrivate) {
      await sendPlainText(chatId, 'Esse site não está na lista de provedores.')
    }
    return
  }
  if (title === 'Embed Link') {
    if (isPrivate) {
      await sendPlainText(chatId, 'Nenhum provedor de embed disponível agora. Tente de novo em instantes.')
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

// Inline mode: one option per provider in list.json; picking one inserts that link directly.
async function onInlineQuery (inlineQuery) {
  const originalURL = extractUrl(inlineQuery.query)
  if (!originalURL) return answerInline(inlineQuery.id, [])

  const results = []
  try {
    const url = new URL(originalURL)
    const matched = matchEntry(url, await fetchList())
    if (matched) {
      getTargets(matched).forEach((target, i) => {
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
    const target = await pickFastestTarget(url, matched.source, getTargets(matched))
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
    title: title,
    matched: !!matched
  }
}

function rewriteUrl (url, sourceRegex, targetHost) {
  const rewritten = new URL(url.toString())
  rewritten.hostname = rewritten.hostname.replace(new RegExp(sourceRegex, 'gi'), targetHost)
  return rewritten
}

// Probes every provider of the entry at the same time and returns the first one that
// proves it serves a playable video (the fastest working provider). If none does within
// PICK_TIMEOUT_MS, it falls back to a provider that only serves an image, otherwise null.
function pickFastestTarget (url, sourceRegex, candidates) {
  return new Promise(resolve => {
    if (!candidates.length) return resolve(null)
    var pending = candidates.length
    var imageFallback = null
    var done = false
    var timer = null
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(imageFallback), PICK_TIMEOUT_MS)
    candidates.forEach(candidate => {
      (async () => {
        const probeUrl = rewriteUrl(url, sourceRegex, candidate).toString()
        // Resolve as soon as either probe confirms a video; don't wait for the slower one
        const directProbe = probeDirectVideoFile(probeUrl).then(ok => {
          if (ok) finish(candidate)
        })
        const embedProbe = probeEmbed(probeUrl).then(tags => {
          if (tags && tags.video) finish(candidate)
          return tags
        })
        const [, tags] = await Promise.all([directProbe, embedProbe])
        if (tags && tags.image && !imageFallback) imageFallback = candidate
      })()
        .catch(() => {})
        .finally(() => {
          pending--
          if (pending === 0) finish(imageFallback)
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
    allowed_updates: JSON.stringify(['message', 'inline_query'])
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
