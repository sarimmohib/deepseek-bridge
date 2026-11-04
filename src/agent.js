import crypto from 'node:crypto';

/**
 * Bridge <-> agent link.
 *
 * An agent opens a WebSocket to the bridge and announces itself. The bridge
 * pushes "job" messages and the agent streams "job.*" events back.
 * All state for a job lives here so a dropped connection fails fast instead of
 * hanging a client request.
 */
export class Agent {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.connections = new Set();
    this.jobs = new Map();
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
    this.log('agent connected');

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
          `agent hello (v${msg.version || '?'}, user=${msg.user || '?'}, tab=${msg.tab}` +
            `${capabilities ? `, caps=${Object.keys(capabilities).filter((k) => capabilities[k]).join('+')}` : ', legacy'})`,
        );
        return;
      }
      if (msg.type === 'pong') return;
      const job = msg.id ? this.jobs.get(msg.id) : null;
      if (!job) return;
      job.onEvent(msg);
    });

    conn.on('close', () => {
      this.connections.delete(conn);
      if (this.connections.size === 0) this.log('agent disconnected');
      else this.log(`agent connection closed (${this.connections.size} still open)`);
      for (const job of this.jobs.values()) {
        if (job.conn === conn) job.fail(new Error('agent disconnected'));
      }
    });
  }

  broadcast(obj) {
    for (const conn of this.connections) conn.sendJSON(obj);
  }

  /**
   * Run a chat job through a connected agent.
   * Resolves with { sessionId, messageId, usage, finish } when the job ends.
   */
  run(payload, handlers = {}, { signal } = {}) {
    if (!this.connected) {
      return Promise.reject(
        new BridgeError(
          'No DeepSeek account is available. Add one with `deepseek login <userToken>`.',
          'not_signed_in',
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
          'The connected client cannot upload images/files. Update it and retry.',
          'client_outdated',
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let accepted = false;
      let firstDelta = false;

      const acceptTimer = setTimeout(() => {
        if (!accepted) fail(new BridgeError('Agent did not accept the job (timed out).', 'agent_timeout'));
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
