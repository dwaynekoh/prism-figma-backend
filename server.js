require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3002;
const LEONARDO_BASE = 'https://cloud.leonardo.ai/api/rest/v1';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Extract user API key from Authorization header ────────────────────────────
function getUserKey(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return process.env.LEONARDO_API_KEY || '';
}

function leonardoHeaders(req) {
  return {
    Authorization: `Bearer ${getUserKey(req)}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function handleError(res, err, fallback) {
  const status  = err?.response?.status  || 500;
  const message = err?.response?.data?.error || err?.message || fallback;
  console.error(`[ERROR] ${fallback}:`, message);
  res.status(status).json({ error: message });
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'prism-figma-backend', ts: new Date().toISOString() })
);

// ─── /api/me  (verify key + balance) ─────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  try {
    const r    = await axios.get(`${LEONARDO_BASE}/me`, { headers: leonardoHeaders(req) });
    const det  = r.data?.user_details?.[0] || {};
    const user = det.user || {};
    res.json({
      user: {
        id:               user.id,
        username:         user.username,
        tokenRenewalDate: det.tokenRenewalDate,
        apiCredit: {
          apiCreditActionModel: {
            totalApiCredit: det.apiCredit?.apiCreditActionModel?.totalApiCredit
              ?? det.subscriptionTokens
              ?? 0,
          },
        },
      },
    });
  } catch (err) { handleError(res, err, 'Failed to fetch user info'); }
});

// ─── /api/balance  (alias) ────────────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  try {
    const r   = await axios.get(`${LEONARDO_BASE}/me`, { headers: leonardoHeaders(req) });
    const det = r.data?.user_details?.[0] || {};
    res.json({
      balance: det.apiCredit?.apiCreditActionModel?.totalApiCredit
             ?? det.subscriptionTokens ?? 0,
    });
  } catch (err) { handleError(res, err, 'Failed to fetch balance'); }
});

// ─── /api/generate ────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { prompt, modelId, width = 1024, height = 1024, numImages = 1,
          quality, referenceImageDataUrls } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const payload = { prompt, modelId, width, height, num_images: numImages };

    if (quality) {
      const qualMap = { low: 'DRAFT', medium: 'STANDARD', high: 'PREMIUM' };
      payload.imageType = qualMap[quality] || 'STANDARD';
    }

    if (referenceImageDataUrls?.length) {
      const imageIds = [];
      for (const dataUrl of referenceImageDataUrls) {
        try {
          const imageId = await uploadInitImageFromDataUrl(req, dataUrl);
          if (imageId) imageIds.push({ imageId });
        } catch (_) {}
      }
      if (imageIds.length) payload.imagePrompts = imageIds;
    }

    const r = await axios.post(`${LEONARDO_BASE}/generations`, payload, {
      headers: leonardoHeaders(req),
    });
    const generationId = r.data?.sdGenerationJob?.generationId;
    if (!generationId) throw new Error('No generationId returned');
    res.json({ sdGenerationJob: { generationId }, generationId });
  } catch (err) { handleError(res, err, 'Image generation failed'); }
});

// ─── /api/generation/:id  (poll) ─────────────────────────────────────────────
app.get('/api/generation/:id', async (req, res) => {
  try {
    const r   = await axios.get(`${LEONARDO_BASE}/generations/${req.params.id}`, { headers: leonardoHeaders(req) });
    const gen = r.data?.generations_by_pk;
    if (!gen) return res.status(404).json({ error: 'Not found' });
    res.json({
      generations_by_pk: {
        status: gen.status,
        generated_images: (gen.generated_images || []).map(img => ({
          id: img.id, url: img.url, width: gen.imageWidth, height: gen.imageHeight,
        })),
      },
    });
  } catch (err) { handleError(res, err, 'Failed to poll generation'); }
});

// ─── /api/generation/:id  (delete) ───────────────────────────────────────────
app.delete('/api/generation/:id', async (req, res) => {
  try {
    await axios.delete(`${LEONARDO_BASE}/generations/${req.params.id}`, { headers: leonardoHeaders(req) });
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'Failed to delete generation'); }
});

// ─── /api/proxy-image ─────────────────────────────────────────────────────────
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.send(r.data);
  } catch (_) { res.status(500).json({ error: 'Proxy failed' }); }
});

// ─── /api/library ─────────────────────────────────────────────────────────────
app.get('/api/library', async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const me  = await axios.get(`${LEONARDO_BASE}/me`, { headers: leonardoHeaders(req) });
    const uid = me.data?.user_details?.[0]?.user?.id;
    if (!uid) throw new Error('Could not get user ID');

    const r    = await axios.get(`${LEONARDO_BASE}/generations/user/${uid}`, {
      headers: leonardoHeaders(req), params: { limit, offset },
    });
    const gens = r.data?.generations || [];
    const images = gens.flatMap(g =>
      (g.generated_images || []).map(img => ({
        id: img.id, url: img.url, width: g.imageWidth, height: g.imageHeight,
        prompt: g.prompt, createdAt: g.createdAt, generationId: g.id,
      }))
    );
    res.json({ images, total: images.length });
  } catch (err) { handleError(res, err, 'Failed to fetch library'); }
});

// ─── /api/library/:id  (delete) ──────────────────────────────────────────────
app.delete('/api/library/:id', async (req, res) => {
  try {
    await axios.delete(`${LEONARDO_BASE}/generations/${req.params.id}`, { headers: leonardoHeaders(req) });
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'Failed to delete image'); }
});

// ─── /api/spark-prompt ───────────────────────────────────────────────────────
app.post('/api/spark-prompt', async (req, res) => {
  const { slideText = '', promptStyle = 'Photography', modelId } = req.body;
  const styleContext = promptStyle === 'Canvafy Me'
    ? 'Choose the most visually stunning style that best represents this content.'
    : `Style: ${promptStyle}.`;

  try {
    const basePrompt = slideText
      ? `${styleContext} Create a compelling image for: "${slideText}".`
      : `${styleContext} Create a compelling standalone image.`;

    const r = await axios.post(
      `${LEONARDO_BASE}/prompt/improve`,
      { prompt: basePrompt },
      { headers: leonardoHeaders(req) }
    );
    const improved = r.data?.promptGeneration?.prompt || basePrompt;
    res.json({ prompt: improved });
  } catch (err) { handleError(res, err, 'Spark Prompt failed'); }
});

// ─── /api/magic-prompt  (alias for spark-prompt) ─────────────────────────────
app.post('/api/magic-prompt', async (req, res) => {
  req.url = '/api/spark-prompt';
  app.handle(req, res);
});

// ─── /api/upload-init-image ───────────────────────────────────────────────────
app.post('/api/upload-init-image', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'imageData required' });
  try {
    const imageId = await uploadInitImageFromDataUrl(req, imageData);
    res.json({ uploadInitImage: { id: imageId }, imageId });
  } catch (err) { handleError(res, err, 'Upload failed'); }
});

async function uploadInitImageFromDataUrl(req, dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const [, mimeType, b64] = match;
  const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'jpg';

  const initRes = await axios.post(
    `${LEONARDO_BASE}/init-image`,
    { extension: ext },
    { headers: leonardoHeaders(req) }
  );
  const { url: uploadUrl, fields, id: imageId } = initRes.data?.uploadInitImage || {};
  if (!uploadUrl || !imageId) throw new Error('No upload URL returned');

  const buffer = Buffer.from(b64, 'base64');
  const FormData = require('form-data');
  const form = new FormData();
  if (fields) Object.entries(fields).forEach(([k,v]) => form.append(k, v));
  form.append('file', buffer, { filename: `upload.${ext}`, contentType: mimeType });

  await axios.post(uploadUrl, form, { headers: form.getHeaders() });
  return imageId;
}

// ─── /api/blueprint-execution  (run) ─────────────────────────────────────────
app.post('/api/blueprint-execution', async (req, res) => {
  const { blueprintVersionId, nodeInputs } = req.body;
  if (!blueprintVersionId) return res.status(400).json({ error: 'blueprintVersionId required' });
  try {
    const r = await axios.post(
      `${LEONARDO_BASE}/executions`,
      { blueprintVersionId, nodeInputs },
      { headers: leonardoHeaders(req) }
    );
    const exec = r.data?.blueprintExecution || r.data;
    const id   = exec?.id || exec?.executionId;
    res.json({ blueprintExecution: { id }, executionId: id });
  } catch (err) { handleError(res, err, 'Blueprint execution failed'); }
});

// ─── /api/blueprint-execution/:id/status  (poll) ─────────────────────────────
app.get('/api/blueprint-execution/:id/status', async (req, res) => {
  try {
    const r = await axios.get(
      `${LEONARDO_BASE}/executions/${req.params.id}`,
      { headers: leonardoHeaders(req) }
    );
    const exec   = r.data?.blueprintExecution || r.data;
    const status = exec?.status || 'PENDING';
    res.json({ status, blueprintExecution: { status } });
  } catch (err) { handleError(res, err, 'Failed to poll blueprint status'); }
});

// ─── /api/blueprint-execution/:id/generations  (results) ─────────────────────
app.get('/api/blueprint-execution/:id/generations', async (req, res) => {
  try {
    const r = await axios.get(
      `${LEONARDO_BASE}/executions/${req.params.id}/generations`,
      { headers: leonardoHeaders(req) }
    );
    const images = r.data?.images || r.data?.generated_images || [];
    res.json({ images });
  } catch (err) { handleError(res, err, 'Failed to fetch blueprint results'); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🚀 PRISM Figma backend running on http://localhost:${PORT}`)
);
