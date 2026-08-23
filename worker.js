/**
 * https://github.com/cvzi/telegram-bot-cloudflare
 */

const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather https://core.telegram.org/bots#6-botfather
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const LIST_URL = ENV_LIST_URL
const WEBHOOK = '/endpoint'

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname !== '/registerWebhook' && url.pathname !== '/unRegisterWebhook' && url.pathname !== '/debug') {
    event.respondWith(new Response('No handler for this request', { status: 404 }))
  } else if (url.searchParams.get('key') !== SECRET || SECRET.length === 0) {
    // Management endpoints require ?key=<ENV_BOT_SECRET>
    event.respondWith(new Response('Forbidden', { status: 403 }))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    event.respondWith(new Response(`isolate ${ISOLATE_ID} saw ${isolateEventCount} webhook events since boot\n\n` + (DEBUG_LOG.join('\n') || 'no events captured yet'), { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  }
})

// In-memory debug trail (per isolate - enough to trace a test click).
// View at /debug. Temporary diagnostics, not a general log.
const DEBUG_LOG = []
const ISOLATE_ID = crypto.randomUUID().slice(0, 8)
let isolateEventCount = 0
function dlog (...args) {
  isolateEventCount++
  const line = new Date().toISOString().slice(11, 23) + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  DEBUG_LOG.push(line)
  if (DEBUG_LOG.length > 100) DEBUG_LOG.shift()
}

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
async function handleWebhook (event) {
  // Check secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    dlog('webhook rejected: bad secret')
    return new Response('Unauthorized', { status: 403 })
  }

  // Read request body synchronously
  const update = await event.request.json()
  dlog('update received:', Object.keys(update).filter(k => k !== 'update_id').join(','))
  // Deal with response asynchronously
  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  } else if ('inline_query' in update) {
    await onInlineQuery(update.inline_query)
  } else if ('chosen_inline_result' in update) {
    await onChosenInlineResult(update.chosen_inline_result)
  }
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (message) {
    const {url, title} = await getFixedURL(message.text)
    return sendPlainText(message.chat.id, url)
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText (chatId, text) {
  return (await fetch(apiUrl('sendMessage', {
    chat_id: chatId,
    text
  }))).json()
}

/**
 * Handle incoming query
 * https://core.telegram.org/bots/api#InlineQuery
 *
 * Answers instantly with a placeholder message - the original link formatted as
 * a clickable platform-name link (e.g. "TikTok") - so the user never waits for
 * service probing. The working embed service is resolved afterwards in
 * onChosenInlineResult, which edits the sent message once probing finishes.
 */
async function onInlineQuery (inlineQuery) {
  const originalURL = inlineQuery.query
  var label = null
  try {
    const url = new URL(originalURL)
    const matched = matchEntry(url, await fetchList())
    label = matched ? matched.name : url.hostname
  } catch (e) {
    console.log("Instant answer: not a URL or list unavailable: ", e.message || e)
  }
  var content
  if (label !== null) {
    content = {
      message_text: `[${label}](${originalURL})`,
      parse_mode: 'markdown',
      link_preview_options: {
        is_disabled: false,
        url: originalURL
      }
    }
  } else {
    // Not a URL (or list fetch failed): plain text, no preview options.
    content = { message_text: originalURL }
  }
  const results = [({
    type: 'article',
    id: crypto.randomUUID(),
    title: '☞ CLICK TO SEND',
    input_message_content: content
  })]
  const res = JSON.stringify(results)
  return SendInlineQuery(inlineQuery.id, res)
}

/**
 * Handle a result the user picked and sent to a chat. Probes all candidate
 * services in parallel (no UI blocking — the message is already out) and edits
 * the message to the winning service link, triggering a fresh link preview.
 * Requires inline feedback to be enabled via @BotFather (/setinlinefeedback).
 */
async function onChosenInlineResult (chosen) {
  try {
    dlog('chosen: inline_message_id present =', !!chosen.inline_message_id)
    if (!chosen.inline_message_id || !chosen.query) return
    console.log("Chosen inline result: ", chosen.query)
    const { url, title } = await getFixedURL(chosen.query)
    if (!title || title === 'Embed Link') {
      dlog('chosen: no embed service found, keeping original link')
      console.log("No embed service found, keeping original link")
      return
    }
    const result = await editInlineMessage(chosen.inline_message_id, `[${title}](${url})`, url)
    dlog('chosen: edit response:', result)
    console.log("Message edited to: ", url)
  } catch (e) {
    dlog('chosen: failed:', e.message || String(e))
    console.log("Failed to resolve/edit embed link: ", e.message || e)
  }
}

/**
 * Edit an inline-mode message and point its link preview at the new URL.
 * https://core.telegram.org/bots/api#editmessagetext
 */
async function editInlineMessage (inlineMessageId, text, url) {
  return (await fetch(apiUrl('editMessageText', {
    inline_message_id: inlineMessageId,
    text,
    parse_mode: 'markdown',
    link_preview_options: JSON.stringify({
      is_disabled: false,
      url
    })
  }))).json()
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
  console.log("Hostname: ", url.hostname)
  if (isTikTokShortLink(url)) {
    url = await canonicalizeTikTokShortLink(url)
  }
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

/**
 * Replace the matched hostname with the target embed service host.
 */
function rewriteUrl (url, sourceRegex, targetHost) {
  const rewritten = new URL(url.toString())
  rewritten.hostname = rewritten.hostname.replace(new RegExp(sourceRegex, 'gi'), targetHost)
  return rewritten
}

/**
 * TikTok share links (vm.tiktok.com/CODE, vt.tiktok.com/CODE, tiktok.com/t/CODE)
 * are resolved to their canonical www.tiktok.com/@user/video/ID form before any
 * service selection, so every embed service receives its primary URL format.
 */
function isTikTokShortLink (url) {
  return /^(vm|vt)\.tiktok\.com$/i.test(url.hostname) || /^\/t\/[^/]+\/?$/i.test(url.pathname)
}

async function canonicalizeTikTokShortLink (url) {
  try {
    console.log("Resolving TikTok short link: ", url.toString())
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': CRAWLER_UA,
        'Range': 'bytes=0-0'
      }
    })
    if (response.body) {
      response.body.cancel()
    }
    const resolved = new URL(response.url)
    if (/tiktok\.com$/i.test(resolved.hostname) && /\/video\/\d+/.test(resolved.pathname)) {
      const canonical = new URL('https://www.tiktok.com' + resolved.pathname)
      console.log("Canonical URL: ", canonical.toString())
      return canonical
    }
    console.log("Short link did not resolve to a video: ", response.url)
  } catch (e) {
    console.log("Short link resolution failed: ", e.message || e)
  }
  return url
}

async function selectTarget (url, sourceRegex, candidates) {
  const probeUrls = new Map(candidates.map(candidate => [candidate, rewriteUrl(url, sourceRegex, candidate).toString()]))
  // Tier 1 — deterministic: a candidate whose rewritten URL serves a direct video
  // file is guaranteed to produce a video preview in Telegram. All candidates are
  // probed in parallel so total latency is one probe, not the sum of all.
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
  // Tier 2 — best effort: HTML embed pages (og:video pointing to a playable file).
  // Only reached when no deterministic (direct file) candidate exists.
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

// Generous per-request budget: probing runs after the message has already been
// sent (see onChosenInlineResult), so latency here never blocks the user. The
// offload .../generate endpoint can need ~6s on cold start.
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

/**
 * Deterministic check: does the URL resolve (following redirects) to a direct
 * video file? Sends a 1-byte Range GET so the media/CDN layer answers directly,
 * bypassing HTML pages and the bot-sniffing protection on them. A "yes" means
 * Telegram will play the URL as an inline video, unconditionally.
 */
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

/**
 * Fetch the embed page and check whether it actually contains a media preview.
 * Returns { video, image } booleans. A candidate counts as a video if either:
 * - the embed URL itself resolves to a direct video file, or
 * - the page declares an og:video URL that resolves to a playable video file.
 */
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

/**
 * True if the given URL resolves (following redirects) to a direct video file.
 */
async function isPlayableVideo (videoUrl) {
  const contentType = await probeContentType(videoUrl)
  return !!contentType.toLowerCase().startsWith('video/')
}

/**
 * Return the Content-Type of a URL. Uses HEAD, falling back to GET for servers
 * that don't support HEAD. Never downloads the body.
 */
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

/**
 * Extract Open Graph meta tags from an HTML string.
 * Returns an object keyed by the lowercased property/name with its content value.
 */
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

/**
 * Send result of the query
 * https://core.telegram.org/bots/api#answerinlinequery
 */

async function SendInlineQuery (inlineQueryId, results) {
  return (await fetch(apiUrl('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results
  }))).json()
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook (event, requestUrl, suffix, secret) {
  // https://core.telegram.org/bots/api#setwebhook
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    // Explicitly request every update type the bot handles - a previously
    // registered restriction would otherwise persist and silently drop
    // chosen_inline_result updates, breaking post-send message editing.
    allowed_updates: JSON.stringify(['message', 'inline_query', 'chosen_inline_result'])
  }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}
