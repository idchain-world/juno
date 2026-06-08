import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { profileDir } from '../lib/profiles.js';

export interface ProfileReloadHub {
  version(): number;
  subscribe(listener: (version: number) => void): () => void;
}

export function profileDevRoutes(env: Env, hub: ProfileReloadHub): Hono {
  const app = new Hono();

  app.get('/', (c) => c.redirect('/profiles/chat'));
  app.get('/profiles/chat', (c) => {
    const slug = env.profileSlug ?? 'default';
    c.header('Cache-Control', 'no-store');
    return c.html(chatHtml(slug, env.openRouterModel, env.judgeModel, loadProfileMetadata(env, slug)));
  });

  app.get('/profiles/assets/:slug/*', (c) => {
    const slug = c.req.param('slug');
    if (!env.profileSlug || slug !== env.profileSlug) return c.notFound();
    const prefix = `/profiles/assets/${encodeURIComponent(slug)}/`;
    const assetPath = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
    const file = resolveProfileAsset(env, slug, assetPath);
    if (!file) return c.notFound();
    return new Response(fs.readFileSync(file), {
      headers: {
        'Content-Type': contentType(file),
        'Cache-Control': 'no-store',
      },
    });
  });

  app.get('/profiles/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send('hello', { version: hub.version() });
        const unsubscribe = hub.subscribe((version) => send('reload', { version }));
        const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 25000);
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}

interface ProfileMetadata {
  name?: string;
  chainId?: number;
  tokenContract?: string;
  tokenId?: string;
  image?: string;
  openseaUrl?: string;
  tagline?: string;
}

function chatHtml(slug: string, model: string, judgeModel: string, metadata: ProfileMetadata | null): string {
  const header = metadata ? profileCardHtml(slug, metadata) : `<h1>${escapeHtml(slug)}</h1>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Juno Profile Chat</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; max-width: 920px; margin: 0 auto; }
    header { padding: 16px 18px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    .meta { margin-top: 4px; color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 13px; }
    .profile-card { display: grid; grid-template-columns: 74px 1fr; gap: 14px; align-items: center; }
    .profile-image, .profile-placeholder { width: 74px; height: 74px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); background: color-mix(in srgb, CanvasText 8%, Canvas); }
    .profile-image { display: block; object-fit: cover; }
    .profile-placeholder { display: grid; place-items: center; color: #f8fafc; background: linear-gradient(135deg, #b91c1c, #ea580c 55%, #111827); font-weight: 800; font-size: 18px; }
    .profile-body { min-width: 0; }
    .profile-name { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.2; }
    .profile-tagline, .profile-token { margin-top: 3px; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
    .profile-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .profile-link { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 4px 8px; color: CanvasText; text-decoration: none; font-size: 12px; font-weight: 650; background: color-mix(in srgb, CanvasText 4%, Canvas); }
    .profile-link:hover { background: color-mix(in srgb, CanvasText 9%, Canvas); }
    #banner { min-height: 20px; margin-top: 8px; color: #0f766e; font-size: 13px; font-weight: 600; }
    #log { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .turn { max-width: 78%; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; line-height: 1.4; white-space: pre-wrap; }
    .user { align-self: flex-end; background: color-mix(in srgb, CanvasText 8%, Canvas); }
    .agent { align-self: flex-start; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 14px 18px 18px; border-top: 1px solid color-mix(in srgb, CanvasText 16%, transparent); }
    textarea { resize: vertical; min-height: 44px; max-height: 160px; padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); font: inherit; background: Canvas; color: CanvasText; }
    button { min-width: 88px; border: 0; border-radius: 8px; background: #1f2937; color: white; font: inherit; font-weight: 650; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: progress; }
  </style>
</head>
<body>
  <main>
    <header>
      ${header}
      <div class="meta">Model ${escapeHtml(model)} · Judge ${escapeHtml(judgeModel)}</div>
      <div id="banner"></div>
    </header>
    <section id="log" aria-live="polite"></section>
    <form id="form">
      <textarea id="message" name="message" autocomplete="off" placeholder="Message ${escapeHtml(slug)}"></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </main>
  <script>
    let sessionId = null;
    const log = document.querySelector('#log');
    const form = document.querySelector('#form');
    const message = document.querySelector('#message');
    const send = document.querySelector('#send');
    const banner = document.querySelector('#banner');

    function addTurn(kind, text) {
      const div = document.createElement('div');
      div.className = 'turn ' + kind;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    const events = new EventSource('/profiles/events');
    events.addEventListener('reload', () => {
      sessionId = null;
      banner.textContent = 'Profile reloaded ↻';
      setTimeout(() => { banner.textContent = ''; }, 3500);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = message.value.trim();
      if (!text) return;
      message.value = '';
      addTurn('user', text);
      send.disabled = true;
      try {
        const response = await fetch('/talk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, from: 'profile-dev-ui', ...(sessionId ? { session_id: sessionId } : {}) })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || body.error || 'request failed');
        sessionId = body.session_id || sessionId;
        addTurn('agent', body.reply || '');
      } catch (err) {
        addTurn('agent', 'Error: ' + err.message);
      } finally {
        send.disabled = false;
        message.focus();
      }
    });
  </script>
</body>
</html>`;
}

function profileCardHtml(slug: string, metadata: ProfileMetadata): string {
  const name = metadata.name?.trim() || slug;
  const image = metadata.image?.trim()
    ? `<img class="profile-image" src="${escapeHtml(metadata.image.trim())}" alt="${escapeHtml(name)}">`
    : `<div class="profile-placeholder" aria-hidden="true">${escapeHtml(initials(slug))}</div>`;
  const tagline = metadata.tagline ? `<div class="profile-tagline">${escapeHtml(metadata.tagline)}</div>` : '';
  const tokenLine = tokenDisplay(metadata);
  const links = profileLinks(metadata);
  return `<div class="profile-card">
        ${image}
        <div class="profile-body">
          <div class="profile-name">${escapeHtml(name)}</div>
          ${tagline}
          ${tokenLine ? `<div class="profile-token">${escapeHtml(tokenLine)}</div>` : ''}
          ${links.length ? `<div class="profile-links">${links.join('')}</div>` : ''}
        </div>
      </div>`;
}

function loadProfileMetadata(env: Env, slug: string): ProfileMetadata | null {
  if (!env.profileSlug || slug !== env.profileSlug) return null;
  const dir = profileDir(env, slug);
  const file = findCaseInsensitive(dir, 'metadata.json');
  if (!file) return null;
  const parsed = parseJsonObject(file);
  if (!parsed) return null;
  const metadata: ProfileMetadata = {};
  const name = stringField(parsed.name);
  const tokenContract = stringField(parsed.tokenContract);
  const tokenId = stringField(parsed.tokenId);
  const openseaUrl = stringField(parsed.openseaUrl);
  const image = stringField(parsed.image);
  if (name) metadata.name = name;
  if (tokenContract) metadata.tokenContract = tokenContract;
  if (tokenId) metadata.tokenId = tokenId;
  if (openseaUrl) metadata.openseaUrl = openseaUrl;
  const chainId = numberField(parsed.chainId);
  if (chainId !== null) metadata.chainId = chainId;
  if (image) metadata.image = normalizeImageSrc(env, slug, image);
  const tagline = parseTagline(readProfileText(dir, 'agent.md'));
  if (tagline) metadata.tagline = tagline;
  return metadata;
}

function profileLinks(metadata: ProfileMetadata): string[] {
  const links: string[] = [];
  if (metadata.openseaUrl) {
    links.push(`<a class="profile-link" href="${escapeHtml(metadata.openseaUrl)}" target="_blank" rel="noreferrer">opensea</a>`);
  }
  const etherscan = etherscanUrl(metadata);
  if (etherscan) {
    links.push(`<a class="profile-link" href="${escapeHtml(etherscan)}" target="_blank" rel="noreferrer">etherscan</a>`);
  }
  return links;
}

function tokenDisplay(metadata: ProfileMetadata): string {
  const contract = metadata.tokenContract ? shortAddress(metadata.tokenContract) : '';
  const token = metadata.tokenId ? `#${metadata.tokenId}` : '';
  const chain = metadata.chainId ? chainName(metadata.chainId) : '';
  const identity = [contract, token].filter(Boolean).join(' ');
  return chain && identity ? `${identity} (on ${chain})` : identity || (chain ? `on ${chain}` : '');
}

function normalizeImageSrc(env: Env, slug: string, image: string): string | undefined {
  if (/^https:\/\//i.test(image)) return image;
  if (/^[a-z][a-z0-9+.-]*:/i.test(image)) return undefined;
  const file = resolveProfileAsset(env, slug, image);
  if (!file) return undefined;
  const relative = path.relative(profileDir(env, slug), file).split(path.sep).map(encodeURIComponent).join('/');
  return `/profiles/assets/${encodeURIComponent(slug)}/${relative}`;
}

function resolveProfileAsset(env: Env, slug: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const dir = profileDir(env, slug);
  const resolved = path.resolve(dir, relativePath);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function parseTagline(agentMd: string | null): string | undefined {
  if (!agentMd) return undefined;
  for (const line of agentMd.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^A\s+(.+?)\s+CC0mon\.?$/i.exec(trimmed);
    if (!match?.[1]) return undefined;
    return match[1].replace(/\s*,\s*/g, ' · ').trim();
  }
  return undefined;
}

function findCaseInsensitive(dir: string, name: string): string | null {
  const exact = path.join(dir, name);
  if (fs.existsSync(exact)) return exact;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return found ? path.join(dir, found) : null;
}

function readProfileText(dir: string, name: string): string | null {
  const file = findCaseInsensitive(dir, name);
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value.length > 0 ? value : null;
}

function parseJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function etherscanUrl(metadata: ProfileMetadata): string | null {
  if (metadata.chainId !== 1 || !metadata.tokenContract || !metadata.tokenId) return null;
  return `https://etherscan.io/nft/${metadata.tokenContract}/${metadata.tokenId}`;
}

function chainName(chainId: number): string {
  if (chainId === 1) return 'Ethereum';
  return `chain ${chainId}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function initials(slug: string): string {
  const parts = slug.split(/[^a-z0-9]+/i).filter(Boolean);
  const chars = parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]) : [slug[0], slug[1]];
  return chars.filter(Boolean).join('').toUpperCase() || '?';
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
