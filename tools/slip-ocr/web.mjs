import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const page = await readFile(new URL('./web.html', import.meta.url));
const maxBodyBytes = 12 * 1024 * 1024;
const upstream = process.env.SLIP_OCR_URL ?? 'http://127.0.0.1:8765';
const host = process.env.SLIP_WEB_HOST ?? '127.0.0.1';
const port = Number(process.env.SLIP_WEB_PORT ?? 8766);

function reply(response, status, contentType, body) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;

  if (request.method === 'GET' && path === '/') {
    reply(response, 200, 'text/html; charset=utf-8', page);
    return;
  }

  if (request.method !== 'POST' || !/^\/api\/slip(?:\/\d+(?:\.\d{1,2})?)?$/.test(path)) {
    reply(response, 404, 'application/json; charset=utf-8', JSON.stringify({ slug: 'not-found' }));
    return;
  }

  if (!request.headers['content-type']?.startsWith('application/json')) {
    reply(response, 415, 'application/json; charset=utf-8', JSON.stringify({ slug: 'unsupported-media-type' }));
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      reply(response, 413, 'application/json; charset=utf-8', JSON.stringify({ slug: 'image-too-large' }));
      return;
    }
    chunks.push(chunk);
  }

  try {
    const result = await fetch(`${upstream}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await result.text();
    reply(response, result.status, 'application/json; charset=utf-8', body);
  } catch {
    reply(response, 503, 'application/json; charset=utf-8', JSON.stringify({ slug: 'ocr-unavailable' }));
  }
}).listen(port, host, () => {
  console.log(`Slip OCR test web listening on http://${host}:${port}`);
});
