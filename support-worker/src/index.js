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
      attachments.push({ filename: f.name.slice(0, 120), content: toBase64(await f.arrayBuffer()), size: f.size });
    }

    const subjectLine = `[${data.theme}] ${data.subject || firstWords(data.message)}`;

    const toSupport = await send(env, {
      from: env.FROM_EMAIL,
      to: [env.TO_EMAIL],
      reply_to: data.email,
      subject: subjectLine,
      text: [
        `New ${data.theme} support request. Reply by ${replyBy(new Date())}.`,
        '',
        `Name: ${data.name}`,
        `Email: ${data.email}`,
        `Store: ${storeUrl(data.store)}`,
        `Theme: ${data.theme}`,
        `Subject: ${data.subject || '(none)'}`,
        `Attachments: ${attachments.length ? attachments.map((a) => a.filename).join(', ') : 'none'}`,
        '',
        data.message,
        '',
        'Reply to this email to answer the merchant directly.',
      ].join('\n'),
      html: internalHtml(data, attachments, subjectLine),
      attachments: attachments.map(({ filename, content }) => ({ filename, content })),
    });
    if (!toSupport.ok) return json({ error: 'We couldn\'t send your message. Please try again in a few minutes.' }, 502, cors);

    // The confirmation is best effort: the request already reached support.
    const firstName = data.name.split(' ')[0];
    await send(env, {
      from: env.FROM_EMAIL,
      to: [data.email],
      reply_to: env.TO_EMAIL,
      subject: `We've got your message: ${subjectLine}`,
      text: [
        `Hi ${firstName},`,
        '',
        `Thanks for getting in touch about ${data.theme}. We've received your message and will reply within one business day, Monday to Friday.`,
        '',
        'In the meantime, the docs might have your answer: https://docs.codecollective.io/tandem/',
        '',
        'Your message:',
        data.message.split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        '--',
        'Code Collective',
        'Support, Monday to Friday',
        'https://codecollective.io',
      ].join('\n'),
      html: confirmationHtml(firstName, data),
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

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function confirmationHtml(firstName, data) {
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const message = escapeHtml(data.message).replace(/\n/g, '<br>');
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f6f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f4;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
<tr><td style="padding:32px 32px 8px;font-family:${font};font-size:16px;line-height:1.6;color:#1c1917;">
<p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 16px;">Thanks for getting in touch about ${escapeHtml(data.theme)}. We've received your message and will reply within one business day, Monday to Friday.</p>
<p style="margin:0 0 24px;">In the meantime, the <a href="https://docs.codecollective.io/tandem/" style="color:#b8501f;">${escapeHtml(data.theme)} docs</a> might have your answer.</p>
<p style="margin:0 0 8px;font-size:13px;color:#78716c;">Your message</p>
<div style="margin:0 0 28px;padding:12px 16px;border-left:3px solid #e7e5e4;background:#fafaf9;color:#44403c;font-size:15px;">${message}</div>
</td></tr>
<tr><td style="padding:0 32px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7e5e4;padding-top:20px;width:100%;">
<tr>
<td width="44" valign="top" style="padding-top:20px;"><a href="https://codecollective.io" style="text-decoration:none;"><img src="https://docs.codecollective.io/email/cc-logo.png" width="28" height="42" alt="Code Collective" style="display:block;border:0;"></a></td>
<td valign="top" style="padding-top:20px;font-family:${font};font-size:14px;line-height:1.5;color:#44403c;">
<strong style="color:#1c1917;font-size:15px;">Code Collective</strong><br>
Support, Monday to Friday<br>
<a href="https://codecollective.io" style="color:#b8501f;text-decoration:none;">codecollective.io</a> &middot; <a href="https://docs.codecollective.io/tandem/" style="color:#b8501f;text-decoration:none;">${escapeHtml(data.theme)} docs</a>
</td>
</tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// One business day after `date`, skipping weekends.
function replyBy(date) {
  const d = new Date(date);
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function storeUrl(store) {
  const s = store.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function adminUrl(store) {
  const m = storeUrl(store).match(/^https?:\/\/([a-z0-9-]+)\.myshopify\.com/i);
  return m ? `https://admin.shopify.com/store/${m[1].toLowerCase()}` : '';
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function internalHtml(data, attachments, subjectLine) {
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const store = storeUrl(data.store);
  const admin = adminUrl(data.store);
  const reply = `mailto:${encodeURIComponent(data.email)}?subject=${encodeURIComponent(`Re: ${subjectLine}`)}`;
  const row = (label, value) => `<tr><td style="padding:8px 0;width:110px;color:#78716c;font-size:13px;vertical-align:top;">${label}</td><td style="padding:8px 0;color:#1c1917;font-size:14px;">${value}</td></tr>`;
  const link = (href, text) => `<a href="${escapeHtml(href)}" style="color:#b8501f;text-decoration:none;">${escapeHtml(text)}</a>`;
  const button = (href, text, primary) => `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;${primary ? 'background:#1c1917;color:#ffffff;' : 'background:#ffffff;color:#1c1917;border:1px solid #d6d3d1;'}">${text}</a>`;
  const files = attachments.length
    ? attachments.map((a) => `${escapeHtml(a.filename)} <span style="color:#a8a29e;">(${formatSize(a.size)})</span>`).join('<br>')
    : '<span style="color:#a8a29e;">None</span>';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f6f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f4;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;font-family:${font};">
<tr><td style="padding:28px 32px 0;">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#b8501f;">New ${escapeHtml(data.theme)} support request</p>
<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#1c1917;">${escapeHtml(data.subject || firstWords(data.message))}</h1>
<p style="margin:0 0 20px;font-size:14px;color:#57534e;">From ${escapeHtml(data.name)}. Reply by <strong style="color:#1c1917;">${replyBy(new Date())}</strong> to keep the one business day promise.</p>
${button(reply, `Reply to ${escapeHtml(data.name.split(' ')[0])}`, true)}${button(store, 'Open store')}${admin ? button(admin, 'Open admin') : ''}
</td></tr>
<tr><td style="padding:20px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4;">
${row('Name', escapeHtml(data.name))}
${row('Email', link(`mailto:${data.email}`, data.email))}
${row('Store', link(store, store.replace(/^https?:\/\//, '')))}
${row('Theme', escapeHtml(data.theme))}
${row('Attachments', files)}
</table>
</td></tr>
<tr><td style="padding:20px 32px 32px;">
<p style="margin:0 0 8px;font-size:13px;color:#78716c;">Message</p>
<div style="padding:14px 16px;border-radius:8px;background:#fafaf9;border:1px solid #f0efee;color:#1c1917;font-size:15px;line-height:1.6;">${escapeHtml(data.message).replace(/\n/g, '<br>')}</div>
<p style="margin:20px 0 0;font-size:13px;color:#a8a29e;">Hitting reply answers ${escapeHtml(data.email)} directly. Screenshots are attached to this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
