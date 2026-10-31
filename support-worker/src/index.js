// Support form endpoint for docs.codecollective.io.
//
// Takes the support form (multipart), emails it to the support inbox with any
// screenshots attached and the merchant as reply-to, then sends the merchant a
// confirmation. Email goes out through Resend.
//
// Secrets (set with `wrangler secret put`, never in this file): RESEND_API_KEY.
// Plain settings live in wrangler.toml.

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // Resend allows 40 MB per email; keep well under.
const ALLOWED_TYPES = /^(image\/(png|jpe?g|gif|webp|heic)|video\/(mp4|quicktime|webm)|application\/pdf)$/;
const THEMES = ['Tandem'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: 'Could not read the form.' }, 400, cors);
    }

    // Bots fill hidden fields and submit instantly; people don't.
    if (field(form, 'website_url')) return json({ ok: true }, 200, cors);
    const started = Number(field(form, 'started')) || 0;
    if (started && Date.now() - started < 3000) return json({ ok: true }, 200, cors);

    const data = {
      name: field(form, 'name'),
      email: field(form, 'email'),
      store: field(form, 'store'),
      theme: field(form, 'theme') || 'Tandem',
      subject: field(form, 'subject'),
      message: field(form, 'message'),
    };

    const missing = ['name', 'email', 'store', 'message'].filter((k) => !data[k]);
    if (missing.length) return json({ error: `Please fill in: ${missing.join(', ')}.` }, 400, cors);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return json({ error: 'Please enter a valid email address.' }, 400, cors);
    if (!THEMES.includes(data.theme)) data.theme = 'Tandem';
    if (data.message.length > 10000) return json({ error: 'Please keep the message under 10,000 characters.' }, 400, cors);

    const files = form.getAll('screenshots').filter((f) => f && typeof f === 'object' && f.size > 0);
    if (files.length > MAX_FILES) return json({ error: `Attach up to ${MAX_FILES} files.` }, 400, cors);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) return json({ error: 'Attachments must be 10 MB or less in total.' }, 400, cors);
    const attachments = [];
    for (const f of files) {
      if (!ALLOWED_TYPES.test(f.type)) return json({ error: `${f.name} isn't an image, video or PDF.` }, 400, cors);
      attachments.push({ filename: f.name.slice(0, 120), content: toBase64(await f.arrayBuffer()) });
    }

    const subjectLine = `[${data.theme}] ${data.subject || firstWords(data.message)}`;

    const toSupport = await send(env, {
      from: env.FROM_EMAIL,
      to: [env.TO_EMAIL],
      reply_to: data.email,
      subject: subjectLine,
      text: [
        `Name: ${data.name}`,
        `Email: ${data.email}`,
        `Store: ${data.store}`,
        `Theme: ${data.theme}`,
        `Subject: ${data.subject || '(none)'}`,
        `Attachments: ${attachments.length}`,
        '',
        data.message,
      ].join('\n'),
      attachments,
    });
    if (!toSupport.ok) return json({ error: 'We couldn\'t send your message. Please try again in a few minutes.' }, 502, cors);

    // The confirmation is best effort: the request already reached support.
    await send(env, {
      from: env.FROM_EMAIL,
      to: [data.email],
      reply_to: env.TO_EMAIL,
      subject: `We've got your message: ${subjectLine}`,
      text: [
        `Hi ${data.name.split(' ')[0]},`,
        '',
        `Thanks for getting in touch about ${data.theme}. We've received your message and will reply within one business day, Monday to Friday.`,
        '',
        'In the meantime, the docs might have your answer: https://docs.codecollective.io/tandem/',
        '',
        'Your message:',
        data.message.split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        'Code Collective',
      ].join('\n'),
    });

    return json({ ok: true }, 200, cors);
  },
};

function field(form, name) {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, 10000) : '';
}

function firstWords(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function send(env, payload) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('Resend', res.status, await res.text());
    return res;
  } catch (error) {
    console.error('Resend unreachable', error);
    return { ok: false };
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
