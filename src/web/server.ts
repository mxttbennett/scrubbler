import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BulkItem } from './bulk.js';
import { type Handlers, HttpError } from './handlers.js';

/**
 * Loopback, as a literal. The process holds a Last.fm session cookie with write access, so any
 * exposure puts that behind a hand-written HTTP surface; keeping the host un-configurable means no
 * deployment can widen it by accident.
 */
const HOST = '127.0.0.1';

/** Every decision is the operator's, so actions record one name rather than a user id. */
const WEB_USER = 'web';

const MAX_BODY_BYTES = 1_000_000;

export interface WebServerOptions {
  port: number;
  handlers: Handlers;
  log?: (message: string) => void;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function num(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asItems(body: unknown): BulkItem[] {
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array');
  return items as BulkItem[];
}

export class WebServer {
  private readonly server: Server;
  private inFlight = 0;
  private idle: (() => void) | undefined;

  constructor(private readonly opts: WebServerOptions) {
    this.server = createServer((req, res) => {
      this.inFlight++;
      void this.dispatch(req, res).finally(() => {
        this.inFlight--;
        if (this.inFlight === 0) this.idle?.();
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, HOST, () => {
        this.opts.log?.(`web grid on http://${HOST}:${String(this.opts.port)}`);
        resolve();
      });
    });
  }

  /**
   * Stops accepting, then waits for the requests already running. A web apply must finish before the
   * process lock is released, for the same reason the worker drains its in-flight edit.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => { resolve(); }));
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.idle = resolve;
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      const result = await this.route(req, url);
      if (result === undefined) {
        this.send(res, 404, { error: 'not found' });
        return;
      }
      if (typeof result === 'string') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(result);
        return;
      }
      this.send(res, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 500) this.opts.log?.(`web error: ${message}`);
      this.send(res, status, { error: message });
    }
  }

  private async route(req: IncomingMessage, url: URL): Promise<unknown> {
    const h = this.opts.handlers;
    const path = url.pathname;
    const get = req.method === 'GET';
    const post = req.method === 'POST';

    if (get && (path === '/' || path === '/index.html')) return this.asset();
    if (get && path === '/api/rows') {
      return h.rows({
        status: url.searchParams.get('status') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
        artist: url.searchParams.get('artist') ?? undefined,
        album: url.searchParams.get('album') ?? undefined,
        limit: num(url.searchParams.get('limit')),
        offset: num(url.searchParams.get('offset')),
      });
    }
    if (get && path === '/api/state') return h.state();
    if (get && path === '/api/rules') return h.listRules();
    if (get && path === '/api/shadow') return h.shadowCounts();
    if (get && path === '/api/album') {
      const artist = url.searchParams.get('artist');
      const album = url.searchParams.get('album');
      if (artist === null || album === null) throw new HttpError(400, 'artist and album are required');
      return h.albumTracks(artist, album);
    }

    if (post) {
      const approval = /^\/api\/approvals\/(\d+)\/(approve|ignore)$/.exec(path);
      if (approval !== null) {
        const id = Number(approval[1]);
        return approval[2] === 'approve' ? h.approve(id, WEB_USER) : h.ignore(id, WEB_USER);
      }
      const retry = /^\/api\/rows\/(\d+)\/retry$/.exec(path);
      if (retry !== null) return h.retry(Number(retry[1]));

      if (path === '/api/bulk') return h.bulk(asItems(await readBody(req)));
      if (path === '/api/rules') {
        const body = (await readBody(req)) as { kind: 'track' | 'album'; artist: string; from: string; to: string };
        return h.addRule(body);
      }
      if (path === '/api/state/pause') {
        const body = (await readBody(req)) as { paused?: boolean };
        return h.setPaused(body.paused === true);
      }
      if (path === '/api/mirror/refresh') return h.startRefresh();
    }

    return undefined;
  }

  private async asset(): Promise<string> {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(join(here, 'app.html'), 'utf8');
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}
