import { jsonResponse, serverError } from '../server/json.js';

const MAX_HTML_LENGTH = 180000;
const REQUEST_TIMEOUT_MS = 6000;
const PREVIEW_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const previewCache = new Map();

function extractMetaTag(html, attribute, value) {
  const pattern = new RegExp(`<meta[^>]*${attribute}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return match ? decodeHtml(match[1].trim()) : '';
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, ' ').trim()) : '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
}

function truncate(value, maxLength = 280) {
  if (!value) return '';
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trim()}…`;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstParagraph(html) {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return '';
  return decodeHtml(stripTags(match[1]));
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'voice-notes-link-preview/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      throw new Error(`Upstream request failed with ${response.status}`);
    }
    const text = await response.text();
    return text.slice(0, MAX_HTML_LENGTH);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPreview(html, url) {
  const ogTitle = extractMetaTag(html, 'property', 'og:title');
  const twitterTitle = extractMetaTag(html, 'name', 'twitter:title');
  const title = truncate(ogTitle || twitterTitle || extractTitle(html) || url, 180);

  const ogDescription = extractMetaTag(html, 'property', 'og:description');
  const metaDescription = extractMetaTag(html, 'name', 'description');
  const twitterDescription = extractMetaTag(html, 'name', 'twitter:description');
  const firstParagraph = extractFirstParagraph(html);
  const description = truncate(ogDescription || twitterDescription || metaDescription || firstParagraph, 320);

  const siteName = truncate(extractMetaTag(html, 'property', 'og:site_name'), 100);

  return {
    title,
    description,
    summary: description,
    siteName,
    url,
  };
}

export async function GET(request) {
  try {
    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('url') || '';
    if (!target) {
      return jsonResponse({ ok: false, error: 'Missing url query parameter.' }, { status: 400 });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid URL.' }, { status: 400 });
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return jsonResponse({ ok: false, error: 'Only HTTP(S) URLs are supported.' }, { status: 400 });
    }

    const normalizedUrl = parsed.toString();
    const cached = previewCache.get(normalizedUrl);
    if (cached && Date.now() - cached.cachedAt < PREVIEW_CACHE_TTL_MS) {
      return jsonResponse({ ok: true, preview: cached.preview, cached: true });
    }

    const html = await fetchHtml(normalizedUrl);
    const preview = buildPreview(html, normalizedUrl);
    previewCache.set(normalizedUrl, {
      cachedAt: Date.now(),
      preview,
    });

    return jsonResponse({ ok: true, preview });
  } catch (error) {
    return serverError(error.message || 'Failed to fetch link preview.');
  }
}
