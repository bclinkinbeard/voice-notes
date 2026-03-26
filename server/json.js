function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

function badRequest(message) {
  return jsonResponse({ ok: false, error: message }, { status: 400 });
}

function unauthorized(message = 'Unauthorized') {
  return jsonResponse({ ok: false, error: message }, { status: 401 });
}

function serverError(message = 'Server error') {
  return jsonResponse({ ok: false, error: message }, { status: 500 });
}

export { badRequest, jsonResponse, readJson, serverError, unauthorized };
