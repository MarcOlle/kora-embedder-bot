const TOKEN = ENV_BOT_TOKEN
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const LIST_URL = ENV_LIST_URL
const WEBHOOK = '/endpoint'
const BOT_VERSION = '2026-08-24.4' // shown in the inline result to identify the live build

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname !== '/registerWebhook' && url.pathname !== '/unRegisterWebhook' && url.pathname !== '/debug') {
    event.respondWith(new Response('No handler for this request', { status: 404 }))
  } else if (url.searchParams.get('key') !== SECRET || SECRET.length === 0) {
    event.respondWith(new Response('Forbidden', { status: 403 }))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    if (!ISOLATE_ID) ISOLATE_ID = crypto.randomUUID().slice(0, 8)
    event.respondWith(new Response(`isolate ${ISOLATE_ID} saw ${isolateEventCount} webhook events since boot\n\n` + (DEBUG_LOG.join('\n') || 'no events captured yet'), { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  }
})

// Per-isolate trail for tracing test clicks; view at /debug?key=...
const DEBUG_LOG = []
let ISOLATE_ID = null // generated lazily: crypto.randomUUID() is banned in global scope
let isolateEventCount = 0
function dlog (...args) {
  if (!ISOLATE_ID) ISOLATE_ID = crypto.randomUUID().slice(0, 8)
  isolateEventCount++
  const line = new Date().toISOString().slice(11, 23) + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  DEBUG_LOG.push(line)
  if (DEBUG_LOG.length > 100) DEBUG_LOG.shift()
}

async function handleWebhook (event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    dlog('webhook rejected: bad secret')
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await event.request.json()
  dlog('update received:', Object.keys(update).filter(k => k !== 'update_id').join(','))
  // Respond Ok immediately; processing continues after the response via waitUntil
  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  } else if ('inline_query' in update) {
    await onInlineQuery(update.inline_query)
  } else if ('chosen_inline_result' in update) {
    await onChosenInlineResult(update.chosen_inline_result)
  }
}

async function onMessage (message) {
    const {url, title} = await getFixedURL(message.text)
    return sendPlainText(message.chat.id, url)
}

async function sendPlainText (chatId, text) {
  return (await fetch(apiUrl('sendMessage', {
    chat_id: chatId,
    text
  }))).json()
}

// Placeholder for a query: original link formatted as a clickable platform name
async function buildPlaceholderContent (query) {
  const url = new URL(query)
  const matched = matchEntry(url, await fetchList())
  const label = matched ? matched.name : url.hostname
  return {
    text: `[${label}](${query})`,
    previewUrl: query,
    label
  }
}

async function onInlineQuery (inlineQuery) {
  const originalURL = inlineQuery.query
  var content = { message_text: originalURL }
  var replyMarkup = null
  try {
    const placeholder = await buildPlaceholderContent(originalURL)
    content = {
      message_text: placeholder.text,
      parse_mode: 'markdown',
      link_preview_options: {
        is_disabled: false,
        url: placeholder.previewUrl
      }
    }
    replyMarkup = { inline_keyboard: [[{ text: '🌐 Open original', url: originalURL }]] }
  } catch (e) {
    console.log("Instant answer: not a URL or list unavailable: ", e.message || e)
  }
  const results = [({
    type: 'article',
    id: crypto.randomUUID(),
    title: `☞ CLICK TO SEND`,
    description: `v${BOT_VERSION}`,
    input_message_content: content,
    // inline keyboard required: without it Telegram omits inline_message_id
    // in chosen_inline_result, making post-send editing impossible
    reply_markup: replyMarkup
  })]
  // cache_time: 0 so repeated queries always hit current code (see BOT_VERSION)
  return SendInlineQuery(inlineQuery.id, JSON.stringify(results), { cache_time: 0 })
}

// Instant answer happens in onInlineQuery; here the services are probed after
// the message is already sent and the message is edited to the winner. Failures
// are annotated onto the message: a fully untouched message means the click
// event never arrived (enable inline feedback via @BotFather /setinlinefeedback).
// TEMPORARY: while debugging delivery, DM every chosen-event step to the user
const DEBUG_NOTIFY = true

async function notify (userId, text) {
  if (!DEBUG_NOTIFY || !userId) return
  try {
    await sendPlainText(userId, text)
  } catch (e) {
    console.log("notify failed: ", e.message || e)
  }
}

async function onChosenInlineResult (chosen) {
  const userId = chosen.from && chosen.from.id
  await notify(userId, `📩 chosen received | query:${!!chosen.query} inline_message_id:${!!chosen.inline_message_id}`)
  if (!chosen.query) return
  if (!chosen.inline_message_id) {
    await notify(userId, '⚠️ no inline_message_id - cannot edit')
    return
  }
  var base = { text: chosen.query, previewUrl: null }
  try {
    const placeholder = await buildPlaceholderContent(chosen.query)
    base = placeholder
    base.keyboard = { inline_keyboard: [[{ text: '🌐 Open original', url: chosen.query }]] }
  } catch (e) {
    console.log("Placeholder rebuild failed: ", e.message || e)
  }
  try {
    console.log("Chosen inline result: ", chosen.query)
    const { url, title } = await getFixedURL(chosen.query)
    if (!title || title === 'Embed Link') {
      dlog('chosen: no embed service found')
      await notify(userId, '⚠️ probe: no working embed service')
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ no working embed service right now`, base.previewUrl, base.keyboard)
      return
    }
    const result = await editInlineMessage(chosen.inline_message_id, `[${title}](${url})`, url, base.keyboard)
    dlog('chosen: edit response:', result)
    await notify(userId, result.ok ? `✅ edited to ${url}` : `⚠️ edit rejected: ${result.description || 'unknown'}`)
    if (!result.ok) {
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ edit rejected: ${result.description || 'unknown'}`, base.previewUrl, base.keyboard)
    }
  } catch (e) {
    dlog('chosen: failed:', e.message || String(e))
    console.log("Failed to resolve/edit embed link: ", e.message || e)
    await notify(userId, `💥 ${String(e.message || e).slice(0, 100)}`)
    try {
      await editInlineMessage(chosen.inline_message_id, `${base.text}\n⚠️ ${String(e.message || e).slice(0, 100)}`, base.previewUrl, base.keyboard)
    } catch (e2) {
      console.log("Annotation edit also failed: ", e2.message || e2)
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

async function fetchList () {
  const response = await fetch(LIST_URL)
  if (!response.ok) {
    throw new Error(`Fetch: ${response.status}`)
  }
  return response.json()
}

function matchEntry (url, json) {
  var matched = null
  json.every(function (entry) {
    const regex = new RegExp(entry.source, 'gi')
    if (!regex.test(url.hostname)) {
      return true
    }
    console.log('Regex detected: ', entry.source)
    matched = entry
    return false
  })
  return matched
}

async function getFixedURL (originalURL) {
  console.log("Original URL: ", originalURL)
  var url = new URL(originalURL)
  const matched = matchEntry(url, await fetchList())
  var title = 'Embed Link'

  if (matched) {
    const candidates = matched.targets || (matched.target ? [matched.target] : [])
    const target = await selectTarget(url, matched.source, candidates)
    if (target) {
      console.log("Selected target: ", target)
      url = rewriteUrl(url, matched.source, target)
      title = matched.name
    } else {
      console.log("No working embed service, returning original URL")
    }
  }

  console.log("Fixed URL: ", url)
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
  // Tier 1: direct video file = deterministic embed signal; all candidates in parallel
  const directChecks = await Promise.all(candidates.map(async candidate => {
    console.log("Direct video file probe: ", probeUrls.get(candidate))
    const ok = await probeDirectVideoFile(probeUrls.get(candidate))
    return { candidate, ok }
  }))
  const directWinner = directChecks.find(result => result.ok)
  if (directWinner) {
    console.log("Direct video file found: ", directWinner.candidate)
    return directWinner.candidate
  }
  // Tier 2: best effort - HTML embed pages (og:video resolving to a playable file)
  const pageChecks = await Promise.all(candidates.map(async candidate => {
    console.log("Probing embed page: ", probeUrls.get(candidate))
    const tags = await probeEmbed(probeUrls.get(candidate))
    return { candidate, tags }
  }))
  const videoWinner = pageChecks.find(result => result.tags.video)
  if (videoWinner) {
    console.log("Video embed found: ", videoWinner.candidate)
    return videoWinner.candidate
  }
  const imageWinner = pageChecks.find(result => result.tags.image)
  if (imageWinner) {
    console.log("Image-only embed found (fallback): ", imageWinner.candidate)
  }
  return imageWinner ? imageWinner.candidate : null
}

// Generous budget: probing runs after the message was already sent (see onChosenInlineResult)
const EMBED_TIMEOUT_MS = 8000
const MAX_BODY_CHARS = 65536
const CRAWLER_UA = 'TelegramBot (like TwitterBot)'

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
      console.log("Direct video file probe status: ", response.status)
      return false
    }
    const contentType = response.headers.get('content-type') || ''
    console.log("Direct video file probe content-type: ", contentType)
    return contentType.toLowerCase().startsWith('video/')
  } catch (e) {
    console.log("Direct video file probe failed: ", e.message || e)
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
      console.log("Probe HTTP status: ", response.status)
      return { video: false, image: false }
    }
    const contentType = response.headers.get('content-type') || ''
    if (contentType.toLowerCase().startsWith('video/')) {
      if (response.body) {
        response.body.cancel()
      }
      console.log("Embed URL is a direct video file: ", probeUrl)
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
      console.log("og:video:type is not a video: ", videoType)
      return { video: false, image }
    }
    const video = await isPlayableVideo(videoUrl)
    console.log("Playable video check: ", videoUrl, video)
    return { video, image }
  } catch (e) {
    console.log("Probe failed: ", e.message || e)
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
    console.log("HEAD probe failed, retrying with GET: ", e.message || e)
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
      console.log("GET probe failed: ", e2.message || e2)
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
