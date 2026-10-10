import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSlip } from './extract.mjs';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function imageFromDataUri(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const image = Buffer.from(match[1], 'base64');
  return image.length > 0 && image.length <= MAX_IMAGE_BYTES ? image : null;
}

export function toOiioLikeResponse(result) {
  return {
    message: 'Slip data extracted for review.',
    data: {
      ref: result.qr?.crc_valid ? result.qr.transaction_ref : null,
      ocr_ref: result.ocr_reference_candidate,
      upload_filename: result.upload_filename,
      date: result.paid_at_bangkok ? new Date(result.paid_at_bangkok).toISOString() : null,
      date_source: result.date_source,
      amount: result.amount,
      sender_bank: result.qr?.crc_valid ? result.qr.sender_bank_code : null,
      sender_bank_name: result.qr?.crc_valid ? result.qr.sender_bank_name ?? result.qr.channel_name ?? null : null,
      sender_name: result.sender_name_candidate,
      receiver_name: result.receiver_name_candidate,
      receiver_label: result.receiver_label_candidate,
      verified: null,
    },
    checks: result.checks,
    warnings: result.warnings,
    verification_scope: 'local_ocr_and_qr_consistency_only',
    payment_confirmed: false,
  };
}

export async function handleRequest(request, response) {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const match = path.match(/^\/api\/slip(?:\/(\d+(?:\.\d{1,2})?))?$/);
  if (request.method !== 'POST' || !match) {
    sendJson(response, 404, { slug: 'not-found' });
    return;
  }
  if (!request.headers['content-type']?.startsWith('application/json')) {
    sendJson(response, 415, { slug: 'unsupported-media-type' });
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      sendJson(response, 413, { slug: 'image-too-large' });
      return;
    }
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    sendJson(response, 400, { slug: 'bad-request' });
    return;
  }
  const image = imageFromDataUri(input?.img);
  if (!image) {
    sendJson(response, 400, { slug: 'invalid-image' });
    return;
  }
  try {
    const result = await readSlip(image, { expectedAmount: match[1] ? Number(match[1]) : null, filename: input?.filename });
    sendJson(response, 200, toOiioLikeResponse(result));
  } catch {
    sendJson(response, 422, { slug: 'invalid-image' });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? process.env.SLIP_OCR_PORT ?? 8765);
  const host = process.env.SLIP_OCR_HOST ?? '127.0.0.1';
  createServer(handleRequest).listen(port, host, () => {
    console.log(`Slip OCR API listening on ${host}:${port}`);
  });
}
