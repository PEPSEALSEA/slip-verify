import assert from 'node:assert/strict';
import test from 'node:test';
import { bankNameFromCode, cleanUploadFilename, compareFilenameToReference, compareReferences, crc16Ccitt, dateFromKPlusReference, dateFromScbReference, dateFromWalletQr, dateTimeFromBangkokBankReference, extractEnglishDestination, extractEnglishRecipientLine, extractIBankAmount, extractKPlusAmount, extractKPlusPromptPayReceiver, extractKPlusRecipientLine, extractLabeledAmount, extractLabeledParties, extractTextFields, parseMiniQr, timeFromOcrDateLine } from './extract.mjs';

test('Thai slip text extracts transfer amount, not fee, and Buddhist date', () => {
  const fields = extractTextFields(`โอนเงินสำเร็จ\n9 ต.ค. 69 19:34 น.\nด.ช. ตัวอย่าง\nธ.กสิกรไทย\nนาย ตัวอย่าง ผู้รับ\nธ.กสิกรไทย\nจำนวน:\n123.45 บาท\nค่าธรรมเนียม:\n0.00 บาท`);
  assert.equal(fields.amount, 123.45);
  assert.equal(fields.paid_at_bangkok, '2026-10-09T19:34:00+07:00');
  assert.equal(fields.receiver_name_candidate, 'นาย ตัวอย่าง ผู้รับ');
});

test('date extraction accepts a Thai OCR misread time separator', () => {
  const fields = extractTextFields('เพพะจะ\n3 ต.ค. 69 20ฯ12 น. ซ๊');
  assert.equal(fields.paid_at_bangkok, '2026-10-03T20:12:00+07:00');
});

test('other bank date layouts accept separators and known Thai OCR month forms', () => {
  assert.equal(extractTextFields('วันที่ทํารายการ 10 เม.ย. 2569 - 12:11').paid_at_bangkok, '2026-04-10T12:11:00+07:00');
  assert.equal(extractTextFields('วันที่ทํารายการ 11 ม.ุย. 2569 -\n10:43').paid_at_bangkok, '2026-06-11T10:43:00+07:00');
  assert.equal(extractTextFields('04 ก.ุย. 2569 - 21:38').paid_at_bangkok, '2026-09-04T21:38:00+07:00');
  assert.equal(extractTextFields('12 เม.ย. 69, 11:35').paid_at_bangkok, '2026-04-12T11:35:00+07:00');
  assert.equal(timeFromOcrDateLine('วันที่ทํารายการ 23 กค.ุย. 2569 17:53:37'), '17:53:37');
});

test('other bank QR date formats are scoped to their observed reference shapes', () => {
  assert.equal(dateFromScbReference('20260904ABCDEFGHIJKLMNOPQ'), '2026-09-04');
  assert.equal(dateFromScbReference('20261304ABCDEFGHIJKLMNOPQ'), null);
  assert.equal(dateTimeFromBangkokBankReference('2026041211350600000000000'), '2026-04-12T11:35:06+07:00');
  const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
  const details = tlv('00', '01') + tlv('01', '01') + tlv('02', 'P2P')
    + tlv('03', '12345678901234') + tlv('04', '23092026');
  const body = tlv('00', details) + '9104';
  const wallet = parseMiniQr(body + crc16Ccitt(body));
  assert.equal(wallet?.format, 'truemoney_p2p_qr');
  assert.equal(wallet?.transaction_ref, '12345678901234');
  assert.equal(wallet?.sender_bank_code, null);
  assert.equal(dateFromWalletQr(wallet), '2026-09-23');
});

test('other bank amounts retain thousands despite OCR punctuation and spaces', () => {
  assert.equal(extractLabeledAmount('จํานวนเงิน 12.194.00 บาท\nค่าธรรมเนียม 0.00 บาท'), 12194);
  assert.equal(extractLabeledAmount('จํานวนเงิน 22 749.00 บาท'), 22749);
  assert.equal(extractLabeledAmount('จํานวนเงิน 1,.600.00 บาท'), 1600);
  assert.equal(extractLabeledAmount('จํานวนเงิน 4 016.93'), 4016.93);
});

test('iBank amount crop accepts one value and rejects ambiguous or fee-only text', () => {
  assert.equal(extractIBankAmount('190.00'), 190);
  assert.equal(extractIBankAmount('1,900.50 บาท'), 1900.5);
  assert.equal(extractIBankAmount('190.00 0.00'), null);
  assert.equal(extractIBankAmount('0.00'), null);
});

test('other bank party labels distinguish names from payment channels', () => {
  assert.deepEqual(extractLabeledParties('จาก น.ส. ตัวอย่าง ผู้โอน\nไปยัง @ นาย ตัวอย่าง ผู้รับ\nxxx-xxx-0000'),
    { sender: 'น.ส. ตัวอย่าง ผู้โอน', receiver: 'นาย ตัวอย่าง ผู้รับ', label: null });
  assert.deepEqual(extractLabeledParties('จาก น.ส. ตัวอย่าง ผู้โอน\nไปยัง เติมเงินพร้อมเพย์\nข้อมูลเพิ่มเติมจากผู้ให้บริการ'),
    { sender: 'น.ส. ตัวอย่าง ผู้โอน', receiver: null, label: 'เติมเงินพร้อมเพย์' });
  assert.deepEqual(extractLabeledParties('จาก น.ส. ตัวอย่าง ผู้โอน\nไปยัง ปัญชีทรู มันนี\n0000000000'),
    { sender: 'น.ส. ตัวอย่าง ผู้โอน', receiver: null, label: 'บัญชีทรูมันนี่' });
});

test('English destination OCR accepts merchant lines but rejects account text', () => {
  assert.deepEqual(extractEnglishDestination('®) EXAMPLE\nUTILITY AUTHORITY'),
    { name: 'EXAMPLE UTILITY AUTHORITY', label: null });
  assert.deepEqual(extractEnglishDestination('EXAMPLE SHOP\n(000000000000000)'),
    { name: 'EXAMPLE SHOP', label: null });
  assert.deepEqual(extractEnglishDestination('m8 ShopeePay'), { name: null, label: 'ShopeePay' });
  assert.deepEqual(extractEnglishDestination('XXX-XXX000-0\nBr Noise 1'), { name: null, label: null });
});

test('cropped K PLUS PromptPay section identifies a single nearby recipient name', () => {
  assert.equal(extractKPlusPromptPayReceiver('นาย ตัวอย่าง ผู้รับ\nรหัสพร้อมเพย์\nxxx-xxx-2390'), 'นาย ตัวอย่าง ผู้รับ');
  assert.equal(extractKPlusPromptPayReceiver('นาย ผู้โอน\nข้อความอื่น'), null);
  assert.equal(extractKPlusPromptPayReceiver('นาย คนแรก\nนาย คนที่สอง\nรหัสพร้อมเพย์'), null);
});

test('upload filename is an informational comparison with the QR reference', () => {
  assert.equal(compareFilenameToReference('016123101500ABC12345.jpeg', '016123101500ABC12345'), true);
  assert.equal(compareFilenameToReference('LINE_20261003.jpg', '016123101500ABC12345'), false);
  assert.equal(compareFilenameToReference(null, '016123101500ABC12345'), null);
  assert.equal(compareFilenameToReference('image.jpg', null), null);
  assert.equal(cleanUploadFilename('C:\\uploads\\image.jpg'), 'image.jpg');
  assert.equal(cleanUploadFilename('bad\nname.jpg'), null);
});

test('observed K PLUS reference date is limited to the 2026 sample format', () => {
  assert.equal(dateFromKPlusReference('016123101500ABC12345'), '2026-05-03T10:15:00+07:00');
  assert.equal(dateFromKPlusReference('016276201200DEF54321'), '2026-10-03T20:12:00+07:00');
  assert.equal(dateFromKPlusReference('016366101500ABC12345'), null);
  assert.equal(dateFromKPlusReference('017123101500ABC12345'), null);
});

test('K PLUS amount crop handles OCR punctuation in thousands and ignores fees', () => {
  assert.equal(extractKPlusAmount('1.000.00 บาท\n0.00 บาท'), 1000);
  assert.equal(extractKPlusAmount('1,.643.59 บาท\n0.00 บาท'), 1643.59);
  assert.equal(extractKPlusAmount('0.00 บาท'), null);
});

test('recipient line distinguishes a name from an e-wallet channel', () => {
  assert.deepEqual(extractKPlusRecipientLine('นาย ตัวอย่าง ผู้รับ', 90), { name: 'นาย ตัวอย่าง ผู้รับ', label: null });
  assert.deepEqual(extractKPlusRecipientLine('พร้อมเพย์ อี-วอลเล็ต / G-Wallet', 90), { name: null, label: 'พร้อมเพย์ อี-วอลเล็ต / G-Wallet' });
  assert.deepEqual(extractKPlusRecipientLine('หแพ๐8 0ด แพแช', 70), { name: null, label: null });
  assert.equal(extractEnglishRecipientLine('EXAMPLE CAFE LIMITED 3', 79), 'EXAMPLE CAFE LIMITED');
  assert.equal(extractEnglishRecipientLine('SAMPLE (THAILAND) CO.,LTD. 3', 78), 'SAMPLE (THAILAND) CO.,LTD.');
  assert.equal(extractEnglishRecipientLine('DEMO FOOD CO.LTD. +', 74), 'DEMO FOOD CO.LTD.');
  assert.equal(extractEnglishRecipientLine('yy. EXAMPLE PERSON', 34), null);
});

test('amount remains unknown when only fee is visible', () => {
  const fields = extractTextFields('ค่าธรรมเนียม:\n0.00 บาท');
  assert.equal(fields.amount, null);
});

test('mini QR CRC detects changed reference', () => {
  const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
  const details = tlv('00', '000001') + tlv('01', '004') + tlv('02', 'EXAMPLE-REFERENCE') + tlv('51', 'TH');
  const body = tlv('00', details) + '9104';
  const payload = body + crc16Ccitt(body);
  const result = parseMiniQr(payload);
  assert.equal(result?.crc_valid, true);
  assert.equal(result?.sender_bank_code, '004');
  assert.equal(result?.sender_bank_name, 'ธ.กสิกรไทย');
  assert.equal(parseMiniQr(payload.replace('EXAMPLE', 'EXAMPLF'))?.crc_valid, false);
});

test('bank code mapping and OCR reference comparison remain local checks', () => {
  assert.equal(bankNameFromCode('099'), 'พร้อมเพย์');
  assert.equal(bankNameFromCode('066'), 'ธ.อิสลามแห่งประเทศไทย');
  assert.equal(bankNameFromCode('999'), null);
  const fields = extractTextFields('เลขที่รายการ:\nEXAMPLE-REFERENCE');
  assert.equal(fields.ocr_reference_candidate, 'EXAMPLE-REFERENCE');
  assert.equal(compareReferences('EXAMPLE-REFERENCE', fields.ocr_reference_candidate), true);
  assert.equal(compareReferences('EXAMPLE-REFERENCE', 'EXAMPLE-REFERENCF'), false);
  assert.equal(compareReferences('EXAMPLE-REFERENCE', null), null);
});
