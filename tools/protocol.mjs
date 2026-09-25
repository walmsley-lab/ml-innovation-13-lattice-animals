// Minimal client for the site's browser websocket protocol (version 1).
// The player socket cannot spectate; this is the session socket the website uses.
const VERSION = 1;
const REQUEST_TIMEOUT_MS = 15_000;

export class Session {
  #socket;
  #pending = new Map();
  #listeners = new Set();
  #nextRequestId = 0;
  #closed;

  constructor(socket) {
    this.#socket = socket;
    this.#closed = new Promise(resolve => {
      socket.addEventListener('close', ({ code, reason }) => {
        for (const request of this.#pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(`Connection closed (${code})`));
        }
        this.#pending.clear();
        resolve({ code, reason });
      });
    });
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'response' && this.#pending.has(message.requestId)) {
        const request = this.#pending.get(message.requestId);
        this.#pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else request.resolve(message.result);
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  get closed() { return this.#closed; }

  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolve once a message satisfies the predicate, or reject on timeout. */
  next(predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Timed out waiting for a message.')); }, timeoutMs);
      const stop = this.onMessage(message => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        stop();
        resolve(message);
      });
    });
  }

  request(type, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.#nextRequestId;
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Request '${type}' timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ ...data, type, requestId, version: VERSION })); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  close() { try { this.#socket.close(1000, 'Client disconnected'); } catch {} }
}

/**
 * Connect and wait for the server's `ready` message. The session socket serves the
 * website, and the server refuses session credentials from a connection that does
 * not present an allowed browser origin.
 */
export async function connect(endpoint, origin = process.env.LATTICE_ORIGIN || 'https://latticeanimals.com') {
  const socket = new WebSocket(endpoint, origin ? { headers: { Origin: origin } } : undefined);
  const session = new Session(socket);
  const ready = session.next(message => message.type === 'ready', 20_000);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot reach ${endpoint}`)), { once: true });
    socket.addEventListener('close', ({ code }) => reject(new Error(`Closed before open (${code})`)), { once: true });
  });
  await ready;
  return session;
}

/**
 * Authenticate a spectator session. A session token avoids putting a password on
 * disk: copy `latticeanimals.session.v1` from the site's browser local storage.
 */
export async function authenticate(session, { token, userName, password }) {
  if (token) return session.request('resume', { token });
  if (userName && password) return session.request('login', { userName, password });
  throw new Error('Set LATTICE_SESSION_TOKEN, or LATTICE_USER and LATTICE_PASSWORD.');
}

export function credentialsFromEnvironment(env = process.env) {
  return { token: env.LATTICE_SESSION_TOKEN, userName: env.LATTICE_USER, password: env.LATTICE_PASSWORD };
}

export const DEFAULT_ENDPOINT = process.env.LATTICE_ENDPOINT || 'wss://latticeanimals.com/ws';
