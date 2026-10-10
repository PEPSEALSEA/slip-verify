# Slip OCR prototype

Version 0.1.0 · Updated 2026-10-10

This is a local, read-only prototype for extracting fields from a Thai e-slip image. It does **not** confirm a bank transfer. No image is sent to a slip-verification service by this tool. Tesseract.js downloads Thai recognition data on first use, and an English model when a recipient or amount needs a second OCR pass; later OCR runs locally. The second step scans the QR in the same image for its transaction reference and CRC.

```powershell
cd tools/slip-ocr
npm install
npm run read -- "C:\path\to\slip.jpeg" --expected-amount 123.45
npm test
```

Run `node tools/slip-ocr/audit.mjs "/path/to/authorized-samples"` from the repository root to check images you have permission to use. Sample slips are not included in this public repository. Set `SLIP_OCR_LANG_PATH` to a directory containing `tha.traineddata` and `eng.traineddata` when offline. Add `--details` to inspect per-file amounts and dates. The audit reports field coverage and filenames that still need manual review; it does not establish payment authenticity or independently prove every OCR value.

For an OIIO-shaped local HTTP interface, run `npm run api`. It listens only on `127.0.0.1:8765` and accepts `POST /api/slip` or `POST /api/slip/:expectedAmount` with JSON `{ "img": "data:image/jpeg;base64,...", "filename": "optional-name.jpeg" }`. It returns `message`, `data` (`ref`, `date`, `amount`, candidate names, uploaded filename), `checks`, and `warnings`. The optional filename is compared with the QR reference for display only; LINE and other apps may rename the image, so a mismatch never blocks extraction or confirms fraud. The local endpoint still performs OCR even when an expected amount is supplied, so the amount can be compared. Its result sets `data.verified` to `null` and `payment_confirmed` to `false` because it has no authorized bank transaction source. It does not implement OIIO's QR-only `/no_slip` route.

For a local test page, run `npm run api` and `npm run web` in separate terminals, then open `http://127.0.0.1:8766`. The page accepts a JPEG, PNG, or WebP slip up to 8 MB and an optional expected amount. `web.mjs` serves the page and forwards the upload to the private OCR API at `127.0.0.1:8765`; it does not save uploaded images. To access the page from another device on the same LAN, set `SLIP_WEB_HOST` to the server's LAN IP. Keep the OCR API bound to localhost. This test page has no login, so do not forward port 8766 to the internet or use it with sensitive real slips on an untrusted network.

The local consistency checks map the sender bank code found in a valid QR to the supplied Thai bank/channel list and compare the QR reference with a labeled reference read by OCR. TrueMoney P2P QR is recognized as a separate wallet format, without inventing a bank code. `checks.qr_reference_matches_ocr` is `true`, `false`, or `null` when OCR cannot find a usable printed reference. For the supplied K PLUS 2026 format, OCR text is compared only when the reference has the complete 12-digit/3-letter/5-digit shape; uncertain OCR is left `null` rather than reported as a mismatch. The observed K PLUS and Bangkok Bank reference formats can supply a Bangkok-local timestamp when printed text is unreadable. SCB references and the TrueMoney QR supply a calendar date that can be combined with OCR time; `data.date_source` states which source was used. These are inferences from the supplied sample set, not bank transaction lookups. A matching reference and recognized bank code do not prove the transfer reached the receiving account; `data.verified` remains `null` and `payment_confirmed` remains `false`.

To run the end-to-end API test with an authorized sample, set `SLIP_OCR_SAMPLE` to its absolute path and `SLIP_OCR_SAMPLE_AMOUNT` to the amount printed on it, then run `npm test`. The test starts an ephemeral localhost server and does not upload the image.

The included Dockerfile downloads Thai and English models at build time and runs with `PORT`, `SLIP_OCR_HOST=0.0.0.0`, and `SLIP_OCR_LANG_PATH=/app/models`. Put authentication and access controls in place before any private deployment. Do not expose this OCR endpoint directly to a browser or treat its output as payment verification.

The output contains a QR transaction reference when the slip QR can be decoded, OCR amount and Bangkok-local time, candidate sender/receiver names, and warnings. Keep the JSON and source image in a restricted location: they may identify a child or a transaction.

`status: extracted_for_review` and `payment_confirmed: false` are deliberate. A valid QR CRC only detects accidental changes to QR text. The mini QR in the supplied slip contains a reference and sending-bank code, but no separate amount, receiver, or transfer-time fields. The date fallback is inferred from the reference format observed in the 2026 K PLUS samples; it is not a bank-provided timestamp. OCR confidence is an overall text score, not proof that amount or payee is correct. Compare against the order amount, approved receiving account, duplicate references, and an authorized transaction source or human bank-statement review before changing `Paid` or granting course access. Account numbers hidden on a slip cannot be reconstructed by OCR.

The parser covers the supplied K PLUS, Krungthai, Bangkok Bank, SCB, and TrueMoney examples. Names are OCR candidates and can remain `null` when the print cannot be read confidently. Do not use this prototype for automatic payment acceptance.
