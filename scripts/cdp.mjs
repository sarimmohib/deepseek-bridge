/*
 * Tiny Chrome DevTools Protocol helper used by the integration test.
 * Node 22+ ships a global WebSocket, so no dependencies are needed.
 */

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const eventListeners = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of eventListeners) {
      try {
        fn(msg);
      } catch {
        /* ignore */
      }
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(fn) {
      eventListeners.push(fn);
    },
    close() {
      ws.close();
    },
  };
}

export async function browserCommand(port, method, params = {}) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const conn = await connect(version.webSocketDebuggerUrl);
  try {
    return await conn.send(method, params);
  } finally {
    conn.close();
  }
}

export async function evaluate(target, expression, { awaitPromise = true } = {}) {
  const conn = await connect(target.webSocketDebuggerUrl);
  try {
    const result = await conn.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate failed');
    }
    return result.result.value;
  } finally {
    conn.close();
  }
}

export async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
