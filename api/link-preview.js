import { badRequest, jsonResponse, serverError } from '../server/json.js';

const REQUEST_TIMEOUT_MS = 7000;
const TWITTER_OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';

function normalizeUrl(rawUrl) {
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return null;
  }

  return parsed.toString();
}

function isTweetUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'twitter.com' && host !== 'x.com') return false;
  return /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(parsed.pathname);
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stripHtml(html) {
  return decodeHtml(String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function clipText(text, max = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function findMetaContent(html, selectors) {
  for (const selector of selectors) {
    const regex = new RegExp(`<meta[^>]+${selector}[^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const match = html.match(regex);
    if (match && match[1]) {
      return decodeHtml(match[1]);
    }
  }
  return '';
}

function findMetaContents(html, selectors) {
  const values = [];
  for (const selector of selectors) {
    const regex = new RegExp(`<meta[^>]+${selector}[^>]+content=["']([^"']+)["'][^>]*>`, 'gi');
    for (const match of html.matchAll(regex)) {
      if (match && match[1]) {
        values.push(decodeHtml(match[1]));
      }
    }
  }
  return values;
}

function findTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]) : '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'voice-notes-preview-bot/1.0',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function buildTweetPreview(url) {
  const endpoint = `${TWITTER_OEMBED_ENDPOINT}?omit_script=1&dnt=1&url=${encodeURIComponent(url)}`;
  const [oembedResponse, tweetResponse] = await Promise.all([
    fetchWithTimeout(endpoint, { headers: { accept: 'application/json' } }),
    fetchWithTimeout(url, { redirect: 'follow' }),
  ]);

  if (!oembedResponse.ok) {
    throw new Error(`Twitter oEmbed failed (${oembedResponse.status})`);
  }

  const payload = await oembedResponse.json();
  const tweetHtml = tweetResponse.ok ? await tweetResponse.text() : '';
  const excerpt = clipText(stripHtml(payload.html));
  const videoCandidates = findMetaContents(tweetHtml, ['property=["\']og:video:url["\']', 'name=["\']twitter:player:stream["\']']);
  const imageCandidates = findMetaContents(tweetHtml, ['property=["\']og:image["\']', 'name=["\']twitter:image["\']']);
  const mediaUrl = videoCandidates[0] || imageCandidates[0] || '';
  const mediaType = videoCandidates[0] ? 'video' : (imageCandidates[0] ? 'image' : '');
  const mediaAlt = findMetaContent(tweetHtml, ['name=["\']twitter:image:alt["\']']) || '';

  return {
    type: 'tweet',
    url,
    title: payload.author_name ? `Post by ${payload.author_name}` : 'Post on X',
    excerpt: excerpt || 'Twitter card preview',
    siteName: 'X (Twitter)',
    authorName: payload.author_name || '',
    authorUrl: payload.author_url || '',
    mediaUrl,
    mediaType,
    mediaAlt,
  };
}

async function buildWebPreview(url) {
  const response = await fetchWithTimeout(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL (${response.status})`);
  }

  const html = await response.text();
  const title = findMetaContent(html, ['property=["\']og:title["\']', 'name=["\']twitter:title["\']']) || findTitle(html);
  const description = findMetaContent(html, ['property=["\']og:description["\']', 'name=["\']description["\']', 'name=["\']twitter:description["\']']);
  const siteName = findMetaContent(html, ['property=["\']og:site_name["\']']);

  return {
    type: 'link',
    url,
    title: clipText(title, 140) || url,
    excerpt: clipText(description, 220) || 'No preview description available.',
    siteName: clipText(siteName, 60),
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const normalizedUrl = normalizeUrl(searchParams.get('url'));
    if (!normalizedUrl) {
      return badRequest('A valid http(s) url query parameter is required.');
    }

    const preview = isTweetUrl(normalizedUrl)
      ? await buildTweetPreview(normalizedUrl)
      : await buildWebPreview(normalizedUrl);

    return jsonResponse({ ok: true, preview }, {
      headers: {
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return serverError(error.message || 'Failed to build link preview.');
  }
}
