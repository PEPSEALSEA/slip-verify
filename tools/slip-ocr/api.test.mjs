import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { handleRequest } from './api.mjs';

test('local OIIO-shaped API keeps extraction separate from payment verification', async t => {
  const samplePath = process.env.SLIP_OCR_SAMPLE;
  const sampleAmount = Number(process.env.SLIP_OCR_SAMPLE_AMOUNT ?? 123.45);
  if (!samplePath) {
    t.skip('Set SLIP_OCR_SAMPLE to an authorized local image for the integration check.');
    return;
  }
  const server = createServer(handleRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const image = await readFile(samplePath);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/slip/${sampleAmount}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ img: `data:image/jpeg;base64,${image.toString('base64')}` }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.amount, sampleAmount);
  assert.equal(body.checks.slip_qr_crc_valid, true);
  assert.equal(body.checks.expected_amount_matches_ocr, true);
  assert.equal(body.data.verified, null);
  assert.equal(body.payment_confirmed, false);

  const wrongAmount = await fetch(`http://127.0.0.1:${server.address().port}/api/slip/${(sampleAmount + 0.01).toFixed(2)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ img: `data:image/jpeg;base64,${image.toString('base64')}` }),
  });
  const mismatch = await wrongAmount.json();
  assert.equal(mismatch.checks.expected_amount_matches_ocr, false);
  assert.ok(mismatch.warnings.includes('amount_mismatch'));
  assert.equal(mismatch.data.verified, null);
});
