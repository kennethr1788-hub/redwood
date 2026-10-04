import { checkPlan, checkCapability, requireThat, integer, MediaError, TERMINAL } from './contract.mjs';

/** No scheduler, automatic retry or background poller. Exactly one explicitly
 * requested transport operation per method. Authorization is private callback
 * policy, never a flag recovered from a journal, plan or model response. */
export class MediaRunner {
  #journal; #transport; #authorize; #clock; #timeout;
  constructor({ journal, transport, authorize = async () => false, clock = Date.now, timeoutMs = 30000 }) {
    integer(timeoutMs, 1, 60000);
    this.#journal = journal; this.#transport = transport; this.#authorize = authorize; this.#clock = clock; this.#timeout = timeoutMs;
  }
  async #bounded(operation) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MediaError('DELIVERY_UNKNOWN')); }, this.#timeout); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  #binding(r) { requireThat(r.connectorId === this.#transport.connectorId && r.mode === this.#transport.mode, 'TRANSPORT_MODE_MISMATCH'); }
  async submit(value, observation, expectedQuote = null) {
    const p = checkPlan(value); checkCapability(p, observation, this.#clock()); this.#binding(p);
    const reserved = this.#journal.reserve(p, expectedQuote);
    requireThat(reserved.state === 'DRAFT', 'NO_RESUBMIT');
    requireThat(await this.#authorize({ operation: 'SUBMIT', request: structuredClone(reserved) }) === true, 'NOT_AUTHORIZED');
    // Recheck after the asynchronous user gate; no stale capability/quote reuse.
    checkCapability(p, observation, this.#clock());
    if (reserved.expectedCost) requireThat(reserved.expectedCost.expiresAt > this.#clock(), 'QUOTE_EXPIRED');
    let r = this.#journal.arm(reserved.requestId), accepting = true;
    try {
      const reply = await this.#bounded(signal => this.#transport.submit(r, p, signal, accepted => {
        requireThat(accepting && !signal.aborted, 'LATE_RECEIPT');
        r = this.#journal.observe(r.requestId, r.revision, accepted);
      }));
      return this.#journal.observe(r.requestId, r.revision, reply);
    } catch { return this.#journal.uncertain(r.requestId, r.revision); }
    finally { accepting = false; }
  }
  async #read(id, method) {
    const r = this.#journal.get(id); this.#binding(r);
    requireThat(r.state !== 'DRAFT' && !TERMINAL.includes(r.state), 'INVALID_TRANSITION');
    if (method === 'poll') requireThat(r.providerRequestId !== null && r.state !== 'UNKNOWN_RECONCILE', 'RECONCILE_REQUIRED');
    requireThat(typeof this.#transport[method] === 'function', 'RECONCILE_UNSUPPORTED');
    try {
      const reply = await this.#bounded(signal => this.#transport[method](r, signal));
      return this.#journal.observe(id, r.revision, reply);
    } catch { return this.#journal.uncertain(id, r.revision); }
  }
  poll(id) { return this.#read(id, 'poll'); }
  reconcile(id) { return this.#read(id, 'reconcile'); }
  async cancel(id) {
    const current = this.#journal.get(id); this.#binding(current);
    requireThat(await this.#authorize({ operation: 'CANCEL', request: structuredClone(current) }) === true, 'NOT_AUTHORIZED');
    const r = this.#journal.requestCancel(id);
    if (typeof this.#transport.cancel !== 'function') return r;
    try {
      const reply = await this.#bounded(signal => this.#transport.cancel(r, signal));
      // 202/accepted is an acknowledgement, not provider state confirmation.
      return reply === null ? r : this.#journal.observe(id, r.revision, reply);
    } catch { return this.#journal.uncertain(id, r.revision); }
  }
}
