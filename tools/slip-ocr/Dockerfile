FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY api.mjs extract.mjs ./

# Download both OCR models during image build, before any slip is processed.
RUN node --input-type=module -e "import { createWorker } from 'tesseract.js'; for (const lang of ['tha', 'eng']) { const worker = await createWorker(lang); await worker.terminate(); }" \
    && test -s tha.traineddata && test -s eng.traineddata \
    && mkdir -p models \
    && mv tha.traineddata eng.traineddata models/

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    PORT=8080 \
    SLIP_OCR_HOST=0.0.0.0 \
    SLIP_OCR_LANG_PATH=/app/models
USER node
EXPOSE 8080
CMD ["node", "api.mjs"]
