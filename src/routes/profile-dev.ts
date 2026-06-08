import { Hono } from 'hono';
import type { Env } from '../env.js';

export interface ProfileReloadHub {
  version(): number;
  subscribe(listener: (version: number) => void): () => void;
}

export function profileDevRoutes(env: Env, hub: ProfileReloadHub): Hono {
  const app = new Hono();

  app.get('/', (c) => c.redirect('/profiles/chat'));
  app.get('/profiles/chat', (c) =>
    c.html(chatHtml(env.profileSlug ?? 'default', env.openRouterModel, env.judgeModel)),
  );

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

function chatHtml(slug: string, model: string, judgeModel: string): string {
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
      <h1>${escapeHtml(slug)}</h1>
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
