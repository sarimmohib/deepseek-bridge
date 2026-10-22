import crypto from 'node:crypto';

/**
 * Bridge <-> extension link.
 *
 * The extension opens a WebSocket to the bridge and announces itself. The
 * bridge pushes "job" messages and the extension streams "job.*" events back.
 * All state for a job lives here so a dropped connection fails fast instead of
 * hanging a client request.
 */
export class Agent {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.connections = new Set();
    this.jobs = new Map();
    this.sessionRequests = new Map();
    this.lastHello = null;
  }

  get connected() {
    return this.connections.size > 0;
  }

  get status() {
    return {
      connected: this.connected,
      connections: this.connections.size,
      lastHello: this.lastHello,
      activeJobs: this.jobs.size,
    };
  }

  attach(conn, query) {
    const expected = query.get('key');
    conn.meta.key = expected;
    this.connections.add(conn);
    this.log('extension connected');

    conn.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        const capabilities = msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : null;
        conn.meta.capabilities = capabilities;
        this.lastHello = {
          at: Date.now(),
          version: msg.version || null,
          user: msg.user || null,
          tab: msg.tab ?? null,
          capabilities,
        };
        this.log(
          `extension hello (v${msg.version || '?'}, user=${msg.user || '?'}, tab=${msg.tab}` +
            `${capabilities ? `, caps=${Object.keys(capabilities).filter((k) => capabilities[k]).join('+')}` : ', legacy'})`,
        );
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'session.exported' || msg.type === 'session.export_error') {
        const request = this.sessionRequests.get(msg.id);
        if (!request) return;
        if (msg.type === 'session.exported') {
          request.finish(null, msg);
        } else {
          request.finish(new BridgeError(msg.message || 'Could not export the browser session.', msg.code || 'session_export_failed'));
        }
        return;
      }
      const job = msg.id ? this.jobs.get(msg.id) : null;
      if (!job) return;
      job.onEvent(msg);
    });

    conn.on('close', () => {
      this.connections.delete(conn);
      if (this.connections.size === 0) this.log('extension disconnected');
      else this.log(`extension connection closed (${this.connections.size} still open)`);
      for (const job of this.jobs.values()) {
        if (job.conn === conn) job.fail(new Error('extension disconnected'));
      }
      for (const request of this.sessionRequests.values()) {
        if (request.conn === conn) request.finish(new BridgeError('Extension disconnected during session export.', 'extension_offline'));
      }
    });
  }

  broadcast(obj) {
    for (const conn of this.connections) conn.sendJSON(obj);
  }

  /**
   * Ask the extension to copy the logged-in chat.deepseek.com cookies and
   * localStorage user token. This is the only operation that needs Chrome.
   */
  exportSession({ timeout = 30000, signal } = {}) {
    if (!this.connected) {
      return Promise.reject(
        new BridgeError(
          'The DeepSeek Bridge extension is not connected. Open Chrome, sign in at https://chat.deepseek.com, then retry `deepseek --login`.',
          'extension_offline',
        ),
      );
    }

    const id = `session_${crypto.randomBytes(8).toString('hex')}`;
    const conn = [...this.connections].at(-1);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this.sessionRequests.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (err, data) => {
        if (settled) return;
        cleanup();
        if (err) reject(err);
        else resolve(data);
      };
      const onAbort = () => finish(new BridgeError('Session export cancelled.', 'cancelled', 499));
      const timer = setTimeout(
        () => finish(new BridgeError('Chrome did not answer the session export request.', 'extension_timeout')),
        timeout,
      );
      timer.unref?.();

      this.sessionRequests.set(id, { id, conn, finish });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      conn.sendJSON({ type: 'session.export', id });
    });
  }

  /**
   * Run a chat job through the extension.
   * Resolves with { sessionId, messageId, usage, finish } when the job ends.
   */
  run(payload, handlers = {}, { signal } = {}) {
    if (!this.connected) {
      return Promise.reject(
        new BridgeError(
          'The DeepSeek Bridge extension is not connected. Open the extension popup and check the port/key, then retry.',
          'extension_offline',
        ),
      );
    }

    const id = `job_${crypto.randomBytes(8).toString('hex')}`;
    // Always drive the newest socket: a reconnecting worker may leave an older
    // socket half-closed, and that one will ignore the job.
    const conn = [...this.connections].at(-1);

    if (payload.attachments?.length && !conn.meta.capabilities?.files) {
      return Promise.reject(
        new BridgeError(
          'The connected extension build cannot upload images/files. Reload the unpacked extension at chrome://extensions (Developer mode → Reload), refresh the chat.deepseek.com tab, then retry.',
          'extension_outdated',
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let accepted = false;
      let firstDelta = false;

      const acceptTimer = setTimeout(() => {
        if (!accepted) fail(new BridgeError('Extension did not accept the job (timed out).', 'extension_timeout'));
      }, 20000);

      const idleTimer = setInterval(() => {
        if (settled) return;
        const idle = Date.now() - job.lastEvent;
        if (idle > (firstDelta ? 180000 : 90000)) {
          fail(new BridgeError('DeepSeek stream stalled (no data).', 'stream_stalled'));
        }
      }, 5000);
      idleTimer.unref?.();

      const hardTimer = setTimeout(() => {
        fail(new BridgeError('Job exceeded the 15 minute limit.', 'timeout'));
      }, 15 * 60 * 1000);
      hardTimer.unref?.();

      const cleanup = () => {
        settled = true;
        clearTimeout(acceptTimer);
        clearInterval(idleTimer);
        clearTimeout(hardTimer);
        this.jobs.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
      };

      const fail = (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        if (settled) return;
        conn.sendJSON({ type: 'job.cancel', id });
        fail(new BridgeError('Client cancelled the request.', 'cancelled'));
      };

      const job = {
        id,
        conn,
        lastEvent: Date.now(),
        fail,
        onEvent: (msg) => {
          job.lastEvent = Date.now();
          switch (msg.type) {
            case 'job.accepted':
              accepted = true;
              clearTimeout(acceptTimer);
              break;
            case 'job.ready':
              handlers.onReady?.(msg);
              break;
            case 'job.delta':
              firstDelta = true;
              handlers.onDelta?.(msg);
              break;
            case 'job.done':
              if (settled) return;
              cleanup();
              resolve({
                sessionId: msg.sessionId,
                messageId: msg.messageId,
                usage: msg.usage || null,
                finish: msg.finish || 'stop',
                title: msg.title || null,
                debugLines: msg.debugLines || null,
              });
              break;
            case 'job.error':
              fail(new BridgeError(msg.message || 'DeepSeek returned an error.', msg.code || 'deepseek_error'));
              break;
            default:
              break;
          }
        },
      };

      this.jobs.set(id, job);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      conn.sendJSON({ type: 'job', id, op: 'chat', payload });
    });
  }
}

export class BridgeError extends Error {
  constructor(message, code = 'bridge_error', status = 502) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}
