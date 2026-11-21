/**
 * Minimal Open-Source Test Shim for `sidecar_sdk`.
 * Used ONLY in standalone CI environments (e.g., GitHub Actions) when Google Antigravity Desktop
 * is not installed on the runner. Inside Antigravity, the real built-in `sidecar_sdk` is always used.
 */
import { createServer } from 'node:http';

export class Response {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

export class SidecarApp {
  #token;
  #port;
  #server;
  #pages = new Map();
  #apis = new Map();

  constructor() {
    this.#token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
    this.#port = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID,
      conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID,
    };
  }

  page(path, handler) {
    this.#pages.set(path, handler);
  }

  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) this.#apis.set(path, new Map());
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }

  run() {
    this.#pages.set('/preload.js', () => '// sidecar_sdk test preload shim\nwindow.sidecar = window.sidecar || {};');
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.#port || 80}`);
      const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
      if (req.method !== 'GET' && url.pathname !== '/preload.js' && this.#token && provided !== this.#token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        const out = await this.#pages.get(url.pathname)();
        if (out instanceof Response) {
          res.writeHead(out.status || 200, { 'Content-Type': out.contentType, ...out.headers });
          res.end(out.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html' });
        res.end(out);
        return;
      }

      if (this.#apis.has(url.pathname)) {
        const methodMap = this.#apis.get(url.pathname);
        if (!methodMap.has(req.method)) {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          try {
            const data = {};
            for (const [k, v] of url.searchParams.entries()) {
              if (k.toLowerCase() !== 'token') data[k] = v;
            }
            if (body) Object.assign(data, JSON.parse(body));
            const result = await methodMap.get(req.method)(data);
            if (result instanceof Response || (result && typeof result === 'object' && result.contentType && result.body !== undefined)) {
              const respBody = typeof result.body === 'string' ? result.body : Buffer.from(result.body);
              res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
              res.end(respBody);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    return new Promise((resolveServer) => {
      this.#server = server.listen(this.#port, '127.0.0.1', () => resolveServer(server));
    });
  }

  close() {
    return new Promise((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }
}
