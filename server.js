require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3002;

const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY;
const LEONARDO_BASE    = 'https://cloud.leonardo.ai/api/rest/v1';

if (!LEONARDO_API_KEY) {
  console.error('LEONARDO_API_KEY is missing');
  process.exit(1);
}

const leonardoHeaders = {
  Authorization: `Bearer ${LEONARDO_API_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'prism-figma-backend' });
});

app.get('/api/balance', async (req, res) => {
  try {
    const response = await axios.get(`${LEONARDO_BASE}/me`, { headers: leonardoHeaders });
    const user = response.data?.user_details?.[0];
    res.json({ tokenBalance: user?.subscriptionTokens ?? user?.apiCredit ?? 0 });
  } catch (err) { handleError(res, err, 'Failed to fetch balance'); }
});

app.post('/api/generate', async (req, res) => {
  const { prompt, modelId = 'b24e16ff-06e3-43eb-8d33-4416c2d75876', width = 1024, height = 1024, num_images = 1, guidance_scale, seed, alchemy = false, photoReal = false, presetStyle, public: isPublic = false, negative_prompt, styleUUID, enhancePrompt = false } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const payload = { prompt, modelId, width, height, num_images, alchemy, photoReal, public: isPublic, enhancePrompt };
    if (guidance_scale !== undefined) payload.guidance_scale = guidance_scale;
    if (seed !== undefined) payload.seed = seed;
    if (presetStyle) payload.presetStyle = presetStyle;
    if (negative_prompt) payload.negative_prompt = negative_prompt;
    if (styleUUID) payload.styleUUID = styleUUID;
    const response = await axios.post(`${LEONARDO_BASE}/generations`, payload, { headers: leonardoHeaders });
    const generationId = response.data?.sdGenerationJob?.generationId;
    if (!generationId) throw new Error('No generationId returned');
    res.json({ generationId });
  } catch (err) { handleError(res, err, 'Generation failed'); }
});

app.get('/api/generation/:id', async (req, res) => {
  try {
    const response = await axios.get(`${LEONARDO_BASE}/generations/${req.params.id}`, { headers: leonardoHeaders });
    const gen = response.data?.generations_by_pk;
    if (!gen) return res.status(404).json({ error: 'Not found' });
    res.json({ status: gen.status, images: (gen.generated_images || []).map(img => ({ id: img.id, url: img.url, nsfw: img.nsfw })) });
  } catch (err) { handleError(res, err, 'Failed to fetch generation'); }
});

app.delete('/api/generation/:id', async (req, res) => {
  try {
    await axios.delete(`${LEONARDO_BASE}/generations/${req.params.id}`, { headers: leonardoHeaders });
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'Failed to delete'); }
});

app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.send(response.data);
  } catch (err) { res.status(500).json({ error: 'Failed to proxy image' }); }
});

app.get('/api/library', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const meResponse = await axios.get(`${LEONARDO_BASE}/me`, { headers: leonardoHeaders });
    const userId = meResponse.data?.user_details?.[0]?.user?.id;
    if (!userId) throw new Error('Could not get user ID');
    const response = await axios.get(`${LEONARDO_BASE}/generations/user/${userId}`, { headers: leonardoHeaders, params: { limit, offset } });
    const images = (response.data?.generations || []).flatMap(gen =>
      (gen.generated_images || []).map(img => ({ id: img.id, url: img.url, prompt: gen.prompt, modelId: gen.modelId, createdAt: gen.createdAt, width: gen.imageWidth, height: gen.imageHeight, generationId: gen.id }))
    );
    res.json({ images, total: images.length });
  } catch (err) { handleError(res, err, 'Failed to fetch library'); }
});

app.post('/api/magic-prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const response = await axios.post(`${LEONARDO_BASE}/prompt/improve`, { prompt }, { headers: leonardoHeaders });
    res.json({ prompt: response.data?.promptGeneration?.prompt || prompt });
  } catch (err) { handleError(res, err, 'Spark Prompt failed'); }
});

app.get('/api/blueprints', (req, res) => res.json({ blueprints: BLUEPRINTS }));

app.post('/api/blueprint-execute', async (req, res) => {
  const { blueprintId, inputs } = req.body;
  const blueprint = BLUEPRINTS.find(b => b.id === blueprintId);
  if (!blueprint) return res.status(404).json({ error: 'Blueprint not found' });
  try {
    let finalPrompt = blueprint.promptTemplate;
    if (inputs) Object.entries(inputs).forEach(([k, v]) => { finalPrompt = finalPrompt.replace(`{${k}}`, v); });
    const payload = { prompt: finalPrompt, modelId: blueprint.modelId || 'b24e16ff-06e3-43eb-8d33-4416c2d75876', width: blueprint.width || 1024, height: blueprint.height || 1024, num_images: 1, alchemy: blueprint.alchemy || false };
    if (blueprint.presetStyle) payload.presetStyle = blueprint.presetStyle;
    const response = await axios.post(`${LEONARDO_BASE}/generations`, payload, { headers: leonardoHeaders });
    const generationId = response.data?.sdGenerationJob?.generationId;
    res.json({ generationId, executionId: generationId });
  } catch (err) { handleError(res, err, 'Blueprint execution failed'); }
});

app.get('/api/blueprint-result/:executionId', async (req, res) => {
  try {
    const response = await axios.get(`${LEONARDO_BASE}/generations/${req.params.executionId}`, { headers: leonardoHeaders });
    const gen = response.data?.generations_by_pk;
    res.json({ status: gen?.status || 'PENDING', images: (gen?.generated_images || []).map(img => ({ id: img.id, url: img.url })) });
  } catch (err) { handleError(res, err, 'Failed to fetch blueprint result'); }
});

const BLUEPRINTS = [
  { id: 'social-post-square', name: 'Social Post - Square', category: 'Social Media', description: 'Eye-catching square image for Instagram or LinkedIn', promptTemplate: 'A professional social media post image about {topic}, vibrant, high quality', inputs: [{ key: 'topic', label: 'Topic', placeholder: 'e.g. product launch' }], width: 1024, height: 1024 },
  { id: 'social-banner-wide', name: 'Social Banner - Wide', category: 'Social Media', description: 'Wide banner for Twitter/X or LinkedIn cover', promptTemplate: 'A wide banner image for {topic}, professional, clean design', inputs: [{ key: 'topic', label: 'Topic', placeholder: 'e.g. company announcement' }], width: 1360, height: 768 },
  { id: 'hero-image', name: 'Hero Image', category: 'Marketing', description: 'Full-width hero for landing pages', promptTemplate: 'A stunning hero image representing {concept}, cinematic quality, wide format', inputs: [{ key: 'concept', label: 'Concept', placeholder: 'e.g. innovation, growth' }], width: 1360, height: 768, alchemy: true },
  { id: 'product-mockup', name: 'Product Mockup', category: 'Marketing', description: 'Clean product-style image on neutral background', promptTemplate: 'Product photography of {product}, clean white background, studio lighting', inputs: [{ key: 'product', label: 'Product', placeholder: 'e.g. a sleek water bottle' }], width: 1024, height: 1024, presetStyle: 'PRODUCT_PHOTOGRAPHY' },
  { id: 'portrait-headshot', name: 'Portrait / Headshot', category: 'People', description: 'Professional portrait-style image', promptTemplate: 'Professional portrait of a {description} person, studio lighting, clean background', inputs: [{ key: 'description', label: 'Description', placeholder: 'e.g. confident business professional' }], width: 832, height: 1216 },
  { id: 'icon-illustration', name: 'Icon / Illustration', category: 'UI & Design', description: 'Flat icon or illustration for UI', promptTemplate: 'Flat vector icon of {subject}, minimal, clean lines, {color} color scheme, white background', inputs: [{ key: 'subject', label: 'Subject', placeholder: 'e.g. a rocket ship' }, { key: 'color', label: 'Color', placeholder: 'e.g. blue and white' }], width: 512, height: 512 },
  { id: 'presentation-bg', name: 'Presentation Background', category: 'UI & Design', description: 'Subtle background for presentation slides', promptTemplate: 'Abstract background for {theme}, subtle, professional, {palette} color palette, no text', inputs: [{ key: 'theme', label: 'Theme', placeholder: 'e.g. technology, finance' }, { key: 'palette', label: 'Colors', placeholder: 'e.g. navy and gold' }], width: 1360, height: 768 },
];

function handleError(res, err, fallbackMessage) {
  const status = err?.response?.status || 500;
  const message = err?.response?.data?.error || err?.message || fallbackMessage;
  console.error(`[ERROR] ${fallbackMessage}:`, message);
  res.status(status).json({ error: message });
}

app.listen(PORT, () => console.log(`PRISM Figma backend running on http://localhost:${PORT}`));
