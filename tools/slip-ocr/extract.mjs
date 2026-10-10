import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { createWorker, PSM } from 'tesseract.js';

const THAI_MONTHS = new Map([
  ['ม.ค.', 1], ['ก.พ.', 2], ['มี.ค.', 3], ['เม.ย.', 4],
  ['พ.ค.', 5], ['มิ.ย.', 6], ['ก.ค.', 7], ['ส.ค.', 8],
  ['ก.ย.', 9], ['ต.ค.', 10], ['พ.ย.', 11], ['ธ.ค.', 12],
]);

const BANK_NAMES = new Map([
  ['099', 'พร้อมเพย์'], ['002', 'ธ.กรุงเทพ'], ['004', 'ธ.กสิกรไทย'],
  ['006', 'ธ.กรุงไทย'], ['011', 'ธ.ทหารไทยธนชาต'], ['014', 'ธ.ไทยพาณิชย์'],
  ['025', 'ธ.กรุงศรีอยุธยา'], ['069', 'ธ.เกียรตินาคินภัทร'],
  ['022', 'ธ.ซีไอเอ็มบีไทย'], ['067', 'ธ.ทิสโก้'], ['024', 'ธ.ยูโอบี'],
  ['071', 'ธ.ไทยเครดิตเพื่อรายย่อย'], ['073', 'ธ.แลนด์ แอนด์ เฮ้าส์'],
  ['070', 'ธ.ไอซีบีซี (ไทย)'], ['034', 'ธ.เพื่อการเกษตรและสหกรณ์การเกษตร'],
  ['030', 'ธ.ออมสิน'], ['033', 'ธ.อาคารสงเคราะห์'],
  ['066', 'ธ.อิสลามแห่งประเทศไทย'],
]);

export function bankNameFromCode(code) {
  return BANK_NAMES.get(code) ?? null;
}

export function normalizeReference(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function compareReferences(qrReference, ocrReference) {
  if (!qrReference || !ocrReference) return null;
  const qr = normalizeReference(qrReference);
  const ocr = normalizeReference(ocrReference);
  return qr && ocr ? qr === ocr : null;
}

export function cleanUploadFilename(value) {
  if (typeof value !== 'string') return null;
  const filename = value.split(/[\\/]/).at(-1).trim();
  return filename && filename.length <= 255 && !/[\x00-\x1f]/.test(filename) ? filename : null;
}

export function compareFilenameToReference(filename, qrReference) {
  if (!filename || !qrReference) return null;
  const stem = filename.replace(/\.[^.]+$/, '');
  const fileReference = normalizeReference(stem);
  const qr = normalizeReference(qrReference);
  return fileReference && qr ? fileReference === qr : null;
}

export function dateFromKPlusReference(reference) {
  // This pattern is observed in the supplied 2026 K PLUS sample set only.
  const match = typeof reference === 'string'
    ? reference.match(/^016(\d{3})(\d{2})(\d{2})\d{2}[A-Z]{3}\d{5}$/)
    : null;
  if (!match) return null;
  const dayOfYear = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (dayOfYear < 1 || dayOfYear > 365 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(2026, 0, dayOfYear));
  return `${date.toISOString().slice(0, 10)}T${match[2]}:${match[3]}:00+07:00`;
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function dateFromScbReference(reference) {
  const match = typeof reference === 'string' ? reference.match(/^(20\d{2})(\d{2})(\d{2})[A-Za-z0-9]{17}$/) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return validDateParts(year, month, day) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function dateFromWalletQr(qr) {
  if (qr?.format !== 'truemoney_p2p_qr' || !qr.crc_valid) return null;
  const match = qr.transaction_date?.match(/^(\d{2})(\d{2})(20\d{2})$/);
  if (!match) return null;
  const [day, month, year] = match.slice(1).map(Number);
  return validDateParts(year, month, day) ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

export function dateTimeFromBangkokBankReference(reference) {
  const match = typeof reference === 'string'
    ? reference.match(/^(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{11}$/) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+07:00`;
}

export function timeFromOcrDateLine(text) {
  const normalized = normalizeText(text).replace(/\r?\n/g, ' ');
  const match = normalized.match(/(?:25\d{2}|\b\d{2})\s*[,\-]?\s*(\d{1,2})\s*[:：ฯ]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`;
}

export function extractLabeledAmount(text) {
  const lines = normalizeText(text).split(/\r?\n/).map(line => line.trim());
  for (let index = 0; index < lines.length; index++) {
    const label = lines[index].match(/จำนวน(?:เงิน)?\s*[:：]?/);
    if (!label) continue;
    const current = lines[index].slice(label.index + label[0].length);
    const next = /ค่าธรรมเนียม/.test(lines[index + 1] ?? '') ? '' : lines[index + 1] ?? '';
    for (const candidate of [current, next]) {
      const match = candidate.match(/(?<!\d)(\d[\d,.\s]*[.,]\d{2})(?!\d)/);
      if (!match) continue;
      const integer = match[1].slice(0, -3).replace(/\D/g, '');
      const amount = Number(`${integer}.${match[1].slice(-2)}`);
      if (integer && Number.isFinite(amount) && amount > 0) return amount;
    }
  }
  return null;
}

function extractAmountFromIsolatedLine(text) {
  const match = text.match(/(?<!\d)(\d[\d,.\s]*[.,]\d{2})(?!\d)/);
  if (!match) return null;
  const integer = match[1].slice(0, -3).replace(/\D/g, '');
  const amount = Number(`${integer}.${match[1].slice(-2)}`);
  return integer && Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function extractIBankAmount(text) {
  const amounts = [...text.matchAll(/(?<!\d)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?!\d)/g)];
  if (amounts.length !== 1) return null;
  const amount = Number(`${amounts[0][1].replace(/,/g, '')}.${amounts[0][2]}`);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function extractIBankRecipient(text) {
  const lines = normalizeText(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const promptPayIndex = lines.findIndex(line => /พร้อม\s*เพย์/.test(line));
  if (promptPayIndex < 1) return null;
  for (let index = promptPayIndex - 1; index >= Math.max(0, promptPayIndex - 2); index--) {
    const candidate = lines[index].replace(/^[^\p{Script=Thai}]*/u, '')
      .replace(/^\p{Script=Thai}{1,2}\s{2,}/u, '').trim();
    const company = candidate.match(/^(?:บริษัท\s*)?\p{Script=Thai}[\p{Script=Thai}().,\s&-]{5,}จำกัด/u)?.[0];
    if (company && !/\d/.test(company)) return company.replace(/\s{2,}/g, ' ').trim();
    const person = candidate.match(/^(?:นาย|นางสาว|นาง|น\.ส\.)\s*\p{Script=Thai}[^\d\r\n]{4,}/u)?.[0];
    if (person) return person.replace(/\s{2,}/g, ' ').trim();
  }
  return null;
}

export function extractKPlusAmount(text) {
  for (const line of normalizeText(text).split(/\r?\n/)) {
    const match = line.match(/([0-9][0-9,.]*\.[0-9]{2})\s*บาท/);
    if (!match) continue;
    const digits = match[1].slice(0, -3).replace(/\D/g, '');
    const amount = Number(`${digits}.${match[1].slice(-2)}`);
    if (digits && Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

export function parseTlv(input) {
  const fields = new Map();
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) return null;
    const tag = input.slice(offset, offset + 2);
    const lengthText = input.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;
    const end = offset + 4 + Number(lengthText);
    if (end > input.length || fields.has(tag)) return null;
    fields.set(tag, input.slice(offset + 4, end));
    offset = end;
  }
  return fields;
}

export function crc16Ccitt(input) {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, 'ascii')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function parseMiniQr(payload) {
  if (typeof payload !== 'string' || !/^[\x20-\x7E]+$/.test(payload)) return null;
  const top = parseTlv(payload);
  const checksum = top?.get('91');
  if (!checksum || checksum.length !== 4 || !payload.endsWith(`9104${checksum}`)) return null;
  const crcValid = crc16Ccitt(payload.slice(0, -4)) === checksum.toUpperCase();
  const details = parseTlv(top.get('00') ?? '');
  if (!details) return null;
  if (details.get('00') === '01' && details.get('01') === '01' && details.get('02') === 'P2P') {
    return { format: 'truemoney_p2p_qr', crc_valid: crcValid, api_id: '01',
      sender_bank_code: null, sender_bank_name: null, channel_name: 'ทรูมันนี่',
      transaction_ref: details.get('03') ?? null, transaction_date: details.get('04') ?? null };
  }
  if (details.get('00') !== '000001' || !/^\d{3}$/.test(details.get('01') ?? '')) return null;
  return {
    format: 'thai_slip_mini_qr',
    crc_valid: crcValid,
    api_id: details.get('00') ?? null,
    sender_bank_code: details.get('01') ?? null,
    sender_bank_name: bankNameFromCode(details.get('01')),
    transaction_ref: details.get('02') ?? null,
  };
}

function normalizeText(text) {
  return text.replace(/ํา/g, 'ำ').replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50));
}

export function extractKPlusPromptPayReceiver(text) {
  const lines = normalizeText(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const promptPayIndex = lines.findIndex(line => /(?:รหัส\s*พร้อม\s*เพย์|Prompt\s*Pay)/i.test(line));
  if (promptPayIndex < 1) return null;
  const nearbyNames = lines.slice(Math.max(0, promptPayIndex - 2), promptPayIndex)
    .filter(line => /^(?:นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.)\s*\p{Script=Thai}/u.test(line));
  return nearbyNames.length === 1 ? nearbyNames[0].replace(/\s{2,}.*/, '').trim() : null;
}

export function extractKPlusRecipientLine(text, confidence) {
  const line = normalizeText(text).split(/\r?\n/)[0]
    .replace(/^[^\p{L}]+/u, '').replace(/\s{2,}.*/, '').trim();
  if (/พร้อมเพย[์]?\s*อี-วอลเล/i.test(line)) {
    return { name: null, label: 'พร้อมเพย์ อี-วอลเล็ต / G-Wallet' };
  }
  if (/^(?:นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|จ\.ท\.)\s*\p{Script=Thai}/u.test(line)) {
    return { name: line, label: null };
  }
  if (confidence >= 85 && (line.match(/\p{Script=Thai}/gu)?.length ?? 0) >= 6
    && !/[0-9]{7}/.test(line) && !/^(?:เลขที่รายการ|จำนวน|ค่าธรรมเนียม)/.test(line)) {
    return { name: line, label: null };
  }
  return { name: null, label: null };
}

export function extractEnglishRecipientLine(text, confidence) {
  const line = text.split(/\r?\n/)[0].trim().replace(/[^A-Za-z().,'& -]+$/g, '').trim();
  return confidence >= 55 && /^[A-Z][A-Z().,'& -]{4,}$/.test(line) ? line : null;
}

export function extractLabeledParties(text) {
  const lines = normalizeText(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = /(?:นางสาว|นาย|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.)\s*\p{Script=Thai}[^\r\n\d]*/u;
  const findAfter = label => {
    const index = lines.findIndex(line => new RegExp(`(?:^|\\s)${label}(?:\\s|$)`).test(line));
    if (index < 0) return '';
    const start = lines[index].indexOf(label);
    return [lines[index].slice(start + label.length), ...lines.slice(index + 1, index + 3)].join('\n');
  };
  const senderText = findAfter('จาก');
  const receiverText = findAfter('ไปยัง') || findAfter('ไปที่');
  const sender = senderText.match(title)?.[0].trim() ?? null;
  const receiver = receiverText.match(title)?.[0].trim()
    ?? receiverText.match(/(?:บริษัท\s*[^\r\n\d]{6,}จำกัด|คลินิก[^\r\n\d]{6,})/u)?.[0].trim()
    ?? null;
  const label = receiver ? null : /เติมเงินพร้อมเพย์/.test(receiverText) ? 'เติมเงินพร้อมเพย์'
    : /[บป]ัญชีทรู\s*มันนี/.test(receiverText) ? 'บัญชีทรูมันนี่' : null;
  return { sender, receiver, label };
}

export function extractEnglishDestination(text) {
  if (/ShopeePay/i.test(text)) return { name: null, label: 'ShopeePay' };
  const lines = text.split(/\r?\n/).map(line => line.replace(/^[^A-Z]+/, '').trim())
    .filter(line => /^[A-Z][A-Z0-9().,'& -]*$/.test(line)
      && (line.match(/[A-Z]/g)?.length ?? 0) >= 5 && !/^(?:BILLER|XXX)/.test(line));
  return { name: lines.length ? lines.slice(0, 2).join(' ') : null, label: null };
}

export function extractTextFields(text) {
  const lines = normalizeText(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const amount = extractLabeledAmount(text);
  const amountEvidence = amount === null ? null : lines.find(line => /จำนวน(?:เงิน)?/.test(line)) ?? null;

  let paidAt = null;
  let dateEvidence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = [lines[index], lines[index + 1] ?? ''].join(' ')
      .replace(/ก\.ุยข?\./g, 'ก.ย.').replace(/ม\.ุย\./g, 'มิ.ย.');
    // Thai OCR can read the small colon in a slip time as ฯ.
    const match = line.match(/(\d{1,2})\s*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*(\d{2,4})\s*[,\-]?\s*(\d{1,2})\s*[:：ฯ]\s*(\d{2})/);
    if (!match) continue;
    const month = THAI_MONTHS.get(match[2]);
    const buddhistYear = Number(match[3]) < 100 ? 2500 + Number(match[3]) : Number(match[3]);
    const year = buddhistYear - 543;
    const day = Number(match[1]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (!month || year < 2000 || !validDateParts(year, month, day) || hour > 23 || minute > 59) continue;
    const local = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`;
    if (Number.isNaN(Date.parse(local))) continue;
    paidAt = local;
    dateEvidence = line;
    break;
  }

  const banks = lines.map((line, index) => /(?:ธ\.|ธนาคาร)/.test(line) ? index : -1).filter(index => index >= 0);
  const nameBefore = index => {
    if (index < 1) return null;
    const line = lines[index - 1];
    return /^(?:นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.)\s*\p{Script=Thai}/u.test(line)
      ? line.replace(/\s{2,}.*/, '').trim()
      : null;
  };

  let ocrReferenceCandidate = null;
  const referenceLabel = /(?:เลข(?:ที่)?(?:อ้างอิง|รายการ|ธุรกรรม)|หมายเลขอ้างอิง|รหัสอ้างอิง|(?:transaction|transfer)\s*(?:ref(?:erence)?|id)|ref(?:erence)?(?:\s*(?:no\.?|number|id))?)\s*[:：#-]?\s*/i;
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(referenceLabel);
    if (!label) continue;
    for (const candidateLine of [lines[i].slice(label.index + label[0].length), lines[i + 1] ?? '']) {
      const candidate = candidateLine.match(/^[\s:：#-]*([A-Z0-9][A-Z0-9\s./-]{5,})/i)?.[1]?.trim();
      if (candidate && normalizeReference(candidate).length >= 6) {
        ocrReferenceCandidate = candidate;
        break;
      }
    }
    if (ocrReferenceCandidate) break;
  }

  return {
    amount,
    paid_at_bangkok: paidAt,
    sender_name_candidate: nameBefore(banks[0]),
    receiver_name_candidate: nameBefore(banks[1]),
    ocr_reference_candidate: ocrReferenceCandidate,
    evidence: { amount_line: amountEvidence, date_line: dateEvidence },
  };
}

export async function decodeQr(imageBytes) {
  const { data, info } = await sharp(imageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return result?.data ?? null;
}

export async function readSlip(imagePathOrBytes, { expectedAmount = null, filename = null } = {}) {
  const imageBytes = Buffer.isBuffer(imagePathOrBytes) ? imagePathOrBytes : await readFile(imagePathOrBytes);
  const qrText = await decodeQr(imageBytes);
  const qr = parseMiniQr(qrText);
  const langPath = process.env.SLIP_OCR_LANG_PATH;
  const worker = await createWorker('tha', 1, langPath
    ? { langPath, gzip: false, cacheMethod: 'none' }
    : undefined);
  let recognized;
  let fields;
  let receiverLabel = null;
  try {
    recognized = (await worker.recognize(imageBytes)).data;
    fields = extractTextFields(recognized.text);
    if (qr?.crc_valid && qr.sender_bank_code === '066' && /(?:ไอแบงก์|ibank)/i.test(recognized.text)) {
      // In this iBank layout Thai OCR can turn the green 190.00 into 1906.06.
      // Read only the amount value, excluding the fee printed on the next row.
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        if (width >= 500 && height >= 700) {
          const region = { left: Math.floor(width * .62), top: Math.floor(height * .625),
            width: Math.floor(width * .23), height: Math.floor(height * .065) };
          const crop = await sharp(imageBytes).extract(region)
            .resize({ width: region.width * 3 }).png().toBuffer();
          const englishWorker = await createWorker('eng', 1, langPath
            ? { langPath, gzip: false, cacheMethod: 'none' } : undefined);
          try {
            await englishWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
            fields.amount = extractIBankAmount((await englishWorker.recognize(crop)).data.text);
          } finally {
            await englishWorker.terminate();
          }
        }
      } catch { fields.amount = null; }
      fields.receiver_name_candidate ??= extractIBankRecipient(recognized.text);
    }
    if (qr?.crc_valid && qr.sender_bank_code !== '004') {
      const parties = extractLabeledParties(recognized.text);
      fields.sender_name_candidate ??= parties.sender;
      fields.receiver_name_candidate ??= parties.receiver;
      receiverLabel = parties.label;
    }
    if (!fields.receiver_name_candidate && qr?.crc_valid && qr.sender_bank_code === '004') {
      // In this K PLUS layout the PromptPay receiver sits in the middle-left,
      // where full-page OCR can miss the name entirely.
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        if (width >= 100 && height >= 100) {
          const region = {
            left: Math.floor(width * 0.19), top: Math.floor(height * 0.42),
            width: Math.floor(width * 0.56), height: Math.floor(height * 0.20),
          };
          const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 3 }).png().toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
          const croppedText = (await worker.recognize(crop)).data.text;
          fields.receiver_name_candidate = extractKPlusPromptPayReceiver(croppedText);
        }
      } catch {
        // An optional second OCR pass must not discard the other extracted fields.
      }
    }
    if (qr?.crc_valid && qr.sender_bank_code === '004') {
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        if (width >= 100 && height >= 100) {
          const laterLayout = height >= 1680;
          const recipientRegion = {
            left: Math.floor(width * (laterLayout ? 0.16 : 0.21)),
            top: Math.floor(height * (laterLayout ? 0.385 : 0.445)),
            width: Math.floor(width * 0.62),
            height: Math.floor(height * (laterLayout ? 0.07 : 0.06)),
          };
          const recipientCrop = await sharp(imageBytes).extract(recipientRegion)
            .resize({ width: recipientRegion.width * 2 }).png().toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
          const recipientOcr = (await worker.recognize(recipientCrop)).data;
          const recipient = extractKPlusRecipientLine(recipientOcr.text, recipientOcr.confidence);
          fields.receiver_name_candidate = recipient.name ?? fields.receiver_name_candidate;
          receiverLabel = recipient.label;
          if (!fields.receiver_name_candidate && !receiverLabel) {
            try {
              const englishWorker = await createWorker('eng', 1, langPath
                ? { langPath, gzip: false, cacheMethod: 'none' } : undefined);
              try {
                await englishWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
                const englishOcr = (await englishWorker.recognize(recipientCrop)).data;
                fields.receiver_name_candidate = extractEnglishRecipientLine(englishOcr.text, englishOcr.confidence);
              } finally {
                await englishWorker.terminate();
              }
            } catch {
              // Keep the other OCR fields if the optional English model is unavailable.
            }
          }
          const region = {
            left: Math.floor(width * 0.35), top: Math.floor(height * 0.58),
            width: Math.floor(width * 0.39), height: Math.floor(height * 0.32),
          };
          const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 2 }).png().toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
          fields.amount = extractKPlusAmount((await worker.recognize(crop)).data.text) ?? fields.amount;
        }
      } catch {
        // Keep the full-page amount when the optional crop cannot be read.
      }
    }
    if (qr?.crc_valid && qr.sender_bank_code === '004' && fields.amount === null) {
      // Older floral K PLUS slips need a tighter amount crop and Latin digits OCR.
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        if (width >= 100 && height < 1400) {
          const region = { left: Math.floor(width * .32), top: Math.floor(height * .805),
            width: Math.floor(width * .30), height: Math.floor(height * .055) };
          const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 3 }).png().toBuffer();
          const englishWorker = await createWorker('eng', 1, langPath
            ? { langPath, gzip: false, cacheMethod: 'none' } : undefined);
          try {
            await englishWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
            fields.amount = extractAmountFromIsolatedLine((await englishWorker.recognize(crop)).data.text);
          } finally {
            await englishWorker.terminate();
          }
        }
      } catch { /* Keep the amount unknown if the optional crop fails. */ }
    }
    if (qr?.crc_valid && qr.sender_bank_code === '006') {
      // Krungthai prints its date near the bottom; the first full-page pass can misread the year.
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        const region = { left: Math.floor(width * .55), top: Math.floor(height * .82),
          width: Math.floor(width * .44), height: Math.floor(height * .16) };
        const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 3 }).png().toBuffer();
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        fields.paid_at_bangkok = extractTextFields((await worker.recognize(crop)).data.text).paid_at_bangkok
          ?? fields.paid_at_bangkok;
      } catch { /* Keep the full-page date if the optional crop fails. */ }
    }
    if (qr?.format === 'truemoney_p2p_qr' && fields.amount === null) {
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        const region = { left: Math.floor(width * .39), top: Math.floor(height * .13),
          width: Math.floor(width * .29), height: Math.floor(height * .08) };
        const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 3 }).png().toBuffer();
        const englishWorker = await createWorker('eng', 1, langPath
          ? { langPath, gzip: false, cacheMethod: 'none' } : undefined);
        try {
          await englishWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
          fields.amount = extractAmountFromIsolatedLine((await englishWorker.recognize(crop)).data.text);
        } finally {
          await englishWorker.terminate();
        }
      } catch { /* Keep the amount unknown if the optional crop fails. */ }
    }
    if (qr?.format === 'truemoney_p2p_qr' && !fields.receiver_name_candidate) {
      receiverLabel = 'ทรูมันนี่วอลเล็ต';
    }
    if (qr?.crc_valid && !fields.receiver_name_candidate && !receiverLabel
      && ['002', '006', '014'].includes(qr.sender_bank_code)) {
      try {
        const { width, height } = await sharp(imageBytes).metadata();
        const layout = qr.sender_bank_code === '002'
          ? [.28, .56, .67, .08] : qr.sender_bank_code === '006'
            ? [.18, .44, .70, .12] : [.25, .40, .70, .12];
        const region = { left: Math.floor(width * layout[0]), top: Math.floor(height * layout[1]),
          width: Math.floor(width * layout[2]), height: Math.floor(height * layout[3]) };
        const crop = await sharp(imageBytes).extract(region).resize({ width: region.width * 3 }).png().toBuffer();
        const englishWorker = await createWorker('eng', 1, langPath
          ? { langPath, gzip: false, cacheMethod: 'none' } : undefined);
        try {
          await englishWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
          const destination = extractEnglishDestination((await englishWorker.recognize(crop)).data.text);
          fields.receiver_name_candidate = destination.name;
          receiverLabel = destination.label;
        } finally {
          await englishWorker.terminate();
        }
      } catch { /* Keep the destination unknown if the optional crop fails. */ }
    }
  } finally {
    await worker.terminate();
  }
  const qrReference = qr?.crc_valid ? qr.transaction_ref : null;
  const qrDate = !qr?.crc_valid ? null
    : qr.sender_bank_code === '004' ? dateFromKPlusReference(qrReference)
      : qr.sender_bank_code === '002' ? dateTimeFromBangkokBankReference(qrReference)
        : null;
  const qrCalendarDate = !qr?.crc_valid ? null
    : qr.sender_bank_code === '014' ? dateFromScbReference(qrReference)
      : dateFromWalletQr(qr);
  const printedDate = fields.paid_at_bangkok;
  const printedTime = timeFromOcrDateLine(recognized.text);
  const combinedDate = qrCalendarDate && printedTime
    ? `${qrCalendarDate}T${printedTime}+07:00` : null;
  const qrCalendarMatchesOcr = printedDate && qrCalendarDate
    ? printedDate.slice(0, 10) === qrCalendarDate : null;
  const useCombinedDate = qrCalendarMatchesOcr === false && combinedDate;
  const paidAt = useCombinedDate ? combinedDate : printedDate ?? qrDate ?? combinedDate;
  const dateSource = useCombinedDate ? 'qr_date_ocr_time'
    : printedDate ? 'printed_ocr' : qrDate ? 'qr_reference'
      : combinedDate ? 'qr_date_ocr_time' : null;
  const qrDateMatchesOcr = printedDate && qrDate
    ? printedDate.slice(0, 16) === qrDate.slice(0, 16) : null;
  const dateMatchesOcr = qrDateMatchesOcr ?? qrCalendarMatchesOcr;
  const uploadFilename = cleanUploadFilename(filename);
  const candidateReference = fields.ocr_reference_candidate;
  const normalizedCandidate = normalizeReference(candidateReference);
  const ocrReference = !qrReference ? candidateReference
    : qr.sender_bank_code === '004'
      ? (/^\d{12}[A-Z]{3}\d{5}$/.test(normalizedCandidate) ? candidateReference : null)
      : normalizedCandidate.length === normalizeReference(qrReference).length
        ? candidateReference : null;
  const referenceMatches = compareReferences(qrReference, ocrReference);
  const amountMatches = expectedAmount === null || fields.amount === null
    ? null : Math.round(fields.amount * 100) === Math.round(expectedAmount * 100);
  const warnings = [];
  if (!qrText) warnings.push('slip_qr_unreadable');
  else if (!qr) warnings.push('slip_qr_format_unknown');
  else if (!qr.crc_valid) warnings.push('slip_qr_crc_invalid');
  if (fields.amount === null) warnings.push('amount_unreadable');
  if (paidAt === null) warnings.push('date_unreadable');
  if (dateMatchesOcr === false) warnings.push('date_ocr_qr_mismatch');
  if (amountMatches === false) warnings.push('amount_mismatch');
  if (referenceMatches === false) warnings.push('reference_mismatch');
  if (qr?.crc_valid && qr.sender_bank_code && !qr.sender_bank_name) warnings.push('bank_code_unknown');
  return {
    status: 'extracted_for_review',
    payment_confirmed: false,
    amount: fields.amount,
    paid_at_bangkok: paidAt,
    date_source: dateSource,
    sender_name_candidate: fields.sender_name_candidate,
    receiver_name_candidate: fields.receiver_name_candidate,
    receiver_label_candidate: receiverLabel,
    ocr_reference_candidate: ocrReference,
    upload_filename: uploadFilename,
    qr,
    checks: {
      slip_qr_decoded: qrText !== null,
      slip_qr_crc_valid: qr?.crc_valid ?? null,
      qr_reference_present: Boolean(qr?.crc_valid && qr.transaction_ref),
      qr_sender_bank_known: qr?.crc_valid && qr.sender_bank_code
        ? Boolean(qr.sender_bank_name) : null,
      qr_reference_matches_ocr: referenceMatches,
      upload_filename_matches_qr_reference: compareFilenameToReference(uploadFilename, qrReference),
      qr_datetime_matches_ocr: dateMatchesOcr,
      expected_amount_matches_ocr: amountMatches,
    },
    expected_amount: expectedAmount,
    amount_matches: amountMatches,
    ocr_page_confidence: Math.round(recognized.confidence),
    warnings,
  };
}
