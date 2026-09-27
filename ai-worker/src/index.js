/*
 * Spread AI. The editor POSTs small copies of the book's images here; Claude looks at them
 * and returns a book plan (order, layouts, cover, colours, alt text, notes, title
 * suggestions, intro). The Anthropic key never leaves this Worker.
 *
 * Secrets (set with `npx wrangler secret put NAME`):
 *   ANTHROPIC_API_KEY   the Anthropic API key
 *   SPREAD_PASSPHRASE   what the editor must send, so strangers can't spend the key
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const MAX_IMAGES = 30;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const SURFACES = ['studio', 'linen', 'oak', 'concrete', 'blush', 'night'];
const LAYOUTS = ['plate', 'bleed', 'spread', 'half'];
const FOCUS = ['50% 50%', '50% 20%', '50% 80%', '20% 50%', '80% 50%'];
const HEX = '^#[0-9a-fA-F]{6}$';

const SYSTEM = `You are the book designer inside Spread, a tool that turns an artist's images into a printed-feeling art book with page-curl pages (portrait pages, 3:4). You look at every image and return a plan for the whole book as JSON.

How the book works:
- After the cover, pages alternate left, right, left, right. Your plan starts on a left-hand page.
- Layouts: "plate" is one piece on a page with a paper margin and a caption; the safe default that never crops the art. "bleed" fills one page edge to edge and crops to 3:4, so use it only when cropping does not hurt the piece. "spread" runs one image across both facing pages; only for landscape images wider than about 1.2:1, and it must start on a left-hand page. "half" puts the image on the top half of a page with text underneath; use it for a photograph of the artist, never for artwork.
- Count pages as you go (a spread uses two, everything else one) so every spread starts on a left-hand page. If one would land on a right-hand page, move a single-page image in front of it.

Sequencing: open strongly, let colour and mood flow from page to page, put pieces that talk to each other on facing pages, and give the strongest pieces the most room. Include every image exactly once.

Cover: choose the image that best represents the book. Pick the cover cloth colour and the endpaper colour from the art itself (hex), and an ink colour for the cover text with strong contrast against the cover colour. Choose the surface the book rests on from: ${SURFACES.join(', ')}.

Writing, for an audience of art lovers, plain and specific, no hype, no em dashes:
- alt: what a blind visitor needs to picture the piece, 1 to 2 sentences, describing what is actually visible.
- note: medium and materials you can actually see, e.g. "Collage with RAM sticks, foil and magazine paper". Leave empty if you cannot tell.
- title_suggestion: a short, evocative working title the artist can accept or replace. These are only suggestions and will be labelled as such.
- intro: a small heading (eyebrow), a heading for the title page, and 1 to 2 sentences about the collection as a whole, based only on what you see.
- For a "half" page with a photo of the artist, heading and body are about the artist; if the artist's name is given in the context use it, and never invent biographical facts.

If the context includes text the artist already wrote for an image, treat it as true and keep your suggestions consistent with it.`;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'cover', 'intro'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['image', 'layout', 'alt', 'note', 'title_suggestion', 'focus', 'heading', 'body'],
        properties: {
          image: { type: 'string', description: 'Image id exactly as given' },
          layout: { type: 'string', enum: LAYOUTS },
          alt: { type: 'string' },
          note: { type: 'string' },
          title_suggestion: { type: 'string' },
          focus: { type: 'string', enum: FOCUS, description: 'Crop anchor for bleed and half layouts' },
          heading: { type: 'string', description: 'Only for half pages; otherwise empty' },
          body: { type: 'string', description: 'Only for half pages; otherwise empty' }
        }
      }
    },
    cover: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'color', 'ink', 'endpaper', 'surface', 'subtitle'],
      properties: {
        image: { type: 'string' },
        color: { type: 'string', pattern: HEX },
        ink: { type: 'string', pattern: HEX },
        endpaper: { type: 'string', pattern: HEX },
        surface: { type: 'string', enum: SURFACES },
        subtitle: { type: 'string', description: 'Short line under the cover title, e.g. the media used' }
      }
    },
    intro: {
      type: 'object',
      additionalProperties: false,
      required: ['eyebrow', 'heading', 'body'],
      properties: {
        eyebrow: { type: 'string' },
        heading: { type: 'string' },
        body: { type: 'string' }
      }
    }
  }
};

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  const ok = origin && (allowed.includes(origin) || local);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Spread-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

// Constant-time comparison so the passphrase can't be guessed from response timing.
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a || '')),
    crypto.subtle.digest('SHA-256', enc.encode(b || ''))
  ]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0 && !!b;
}

function buildContent(images, context) {
  const content = [];
  const lines = [];
  if (context.artist) lines.push(`Artist: ${context.artist}`);
  if (context.title) lines.push(`Book title: ${context.title}`);
  content.push({
    type: 'text',
    text: `${lines.join('\n') || 'No extra context.'}\n\nThere are ${images.length} images. Each one follows its id, size and any text the artist already wrote.`
  });
  for (const im of images) {
    const known = ['caption', 'note', 'heading', 'body']
      .filter((k) => im.text && im.text[k])
      .map((k) => `${k}: ${im.text[k]}`);
    content.push({
      type: 'text',
      text: `Image id: ${im.id} (${im.width}x${im.height}${im.width / im.height > 1.2 ? ', landscape' : ''})${known.length ? '\nArtist wrote: ' + known.join('; ') : ''}`
    });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } });
  }
  content.push({ type: 'text', text: 'Plan the book.' });
  return content;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, headers);

    if (!(await same(request.headers.get('X-Spread-Key'), env.SPREAD_PASSPHRASE))) {
      return json({ error: 'Wrong passphrase.' }, 401, headers);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) {
      return json({ error: 'Too much data. Send smaller image copies.' }, 413, headers);
    }

    let payload;
    try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400, headers); }
    const images = Array.isArray(payload.images) ? payload.images : [];
    if (!images.length) return json({ error: 'No images.' }, 400, headers);
    if (images.length > MAX_IMAGES) return json({ error: `At most ${MAX_IMAGES} images.` }, 400, headers);
    for (const im of images) {
      if (!im || typeof im.id !== 'string' || typeof im.data !== 'string' ||
          !/^image\/(webp|jpeg|png)$/.test(im.type || '')) {
        return json({ error: 'Each image needs an id, a type (webp, jpeg or png) and base64 data.' }, 400, headers);
      }
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
        messages: [{ role: 'user', content: buildContent(images, payload.context || {}) }]
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return json({ error: 'The Anthropic API key is not valid.' }, 502, headers);
      if (err instanceof Anthropic.RateLimitError) return json({ error: 'Claude is busy. Try again in a minute.' }, 503, headers);
      if (err instanceof Anthropic.BadRequestError) return json({ error: 'Claude could not read that request: ' + err.message }, 502, headers);
      if (err instanceof Anthropic.APIError) return json({ error: `Claude returned an error (${err.status}).` }, 502, headers);
      return json({ error: 'Could not reach Claude.' }, 502, headers);
    }

    if (response.stop_reason === 'refusal') {
      return json({ error: 'Claude declined to arrange these images.' }, 422, headers);
    }
    if (response.stop_reason === 'max_tokens') {
      return json({ error: 'The plan was cut off. Try fewer images.' }, 502, headers);
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let plan;
    try { plan = JSON.parse(text); } catch { return json({ error: 'Claude returned an unreadable plan.' }, 502, headers); }

    return json({ plan, model: response.model, usage: response.usage }, 200, headers);
  }
};
