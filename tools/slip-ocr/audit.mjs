import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readSlip } from './extract.mjs';

const directory = resolve(process.argv[2] ?? '../../test-slip/004-KPlus');
const includeDetails = process.argv.includes('--details');
const selected = new Set(process.argv.slice(3).filter(argument => argument !== '--details'));
const files = (await readdir(directory)).filter(name => /\.(?:jpe?g|png|webp)$/i.test(name)
  && (!selected.size || selected.has(name))).sort();
const totals = { files: files.length, qr_valid: 0, date: 0, amount: 0, sender: 0,
  receiver_name: 0, receiver_label: 0, printed_date: 0, qr_date: 0, date_agreement: 0,
  reference_mismatch: 0, other_warnings: 0 };
const exceptions = [];
const missingRecipients = [];
const missingSenders = [];
const details = [];
for (const [index, name] of files.entries()) {
  const result = await readSlip(join(directory, name), { filename: name });
  if (result.qr?.crc_valid) totals.qr_valid++;
  if (result.paid_at_bangkok) totals.date++;
  if (result.amount !== null) totals.amount++;
  if (result.sender_name_candidate) totals.sender++;
  if (result.receiver_name_candidate) totals.receiver_name++;
  if (result.receiver_label_candidate) totals.receiver_label++;
  if (includeDetails) details.push({ file: name, bank: result.qr?.sender_bank_code ?? result.qr?.channel_name,
    amount: result.amount, date: result.paid_at_bangkok, date_source: result.date_source,
    sender_read: Boolean(result.sender_name_candidate), receiver_read: Boolean(result.receiver_name_candidate || result.receiver_label_candidate) });
  if (!result.receiver_name_candidate && !result.receiver_label_candidate) missingRecipients.push(name);
  if (!result.sender_name_candidate) missingSenders.push(name);
  if (result.date_source === 'printed_ocr') totals.printed_date++;
  if (result.date_source === 'qr_reference') totals.qr_date++;
  if (result.checks.qr_datetime_matches_ocr === true) totals.date_agreement++;
  if (result.warnings.includes('reference_mismatch')) totals.reference_mismatch++;
  const warnings = result.warnings.filter(warning => warning !== 'reference_mismatch');
  if (warnings.length) totals.other_warnings++;
  if (!result.qr?.crc_valid || !result.paid_at_bangkok || result.amount === null || warnings.length || result.checks.qr_datetime_matches_ocr === false) {
    exceptions.push({ file: name, amount: result.amount, date: result.paid_at_bangkok,
      warnings, date_agreement: result.checks.qr_datetime_matches_ocr });
  }
  if ((index + 1) % 15 === 0) console.error(`Checked ${index + 1}/${files.length}`);
}
console.log(JSON.stringify({ totals, exceptions, missingRecipients, missingSenders, ...(includeDetails ? { details } : {}) }, null, 2));
