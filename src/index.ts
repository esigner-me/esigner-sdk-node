/**
 * @esigner/sdk — the official client for the esigner API (https://esigner.no/dokumentasjon).
 *
 * One dependency-free module on the platform's own `fetch`, so it runs on Node 18+, Bun, Deno and
 * edge runtimes alike. Every type comes from the API's OpenAPI spec (src/generated, refreshed with
 * `pnpm sdk:gen` at the repo root; the API's test suite fails while the snapshot is stale), so a
 * field the API documents is a field this client knows about.
 *
 * What it adds over raw HTTP: an Idempotency-Key on every POST that stays the same across retries,
 * retries on network errors, 429 and 5xx (honouring Retry-After), errors with the API's stable code,
 * cursor pagination as async iterators, and webhook verification done right.
 */
import type { components, paths } from "./generated/openapi.js";

type Schemas = components["schemas"];
type JsonBody<P extends keyof paths, M extends "post"> =
  paths[P][M] extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;
type Ok<P extends keyof paths, M extends "get" | "post", C extends number = 200> =
  paths[P][M] extends { responses: { [K in C]: { content: { "application/json": infer R } } } } ? R : never;

export type SignatureRequest = Schemas["SignatureRequest"];
export type Document = Schemas["Document"];
export type SignedDocument = Schemas["SignedDocument"];
export type ApiEvent = Schemas["Event"];
export type CreateSignatureRequestParams = JsonBody<"/signature_requests", "post">;
export type CancelSignatureRequestResult = Ok<"/signature_requests/{id}/cancel", "post">;
export type SignedDocumentList = Ok<"/signature_requests/{id}/signed_documents", "get">;
export type Balance = Ok<"/balance", "get">;
export type BalanceTransaction = Ok<"/balance/transactions", "get">["data"][number];

/** A webhook delivery, narrowed by `type` to the payload that event carries. */
export type WebhookEvent = Omit<Schemas["WebhookEvent"], "type" | "data"> & (
  | { type: "document.completed"; data: Schemas["DocumentCompletedData"] }
  | { type: "document.signing_failed"; data: Schemas["DocumentSigningFailedData"] }
  | { type: "document.cancelled"; data: Schemas["DocumentCancelledData"] }
  | { type: "signer.signed"; data: Schemas["SignerSignedData"] }
  | { type: "signer.declined"; data: Schemas["SignerDeclinedData"] }
  | { type: "order.captured"; data: Schemas["OrderCapturedData"] }
);
export type WebhookEventType = WebhookEvent["type"];

/** The API's own markets. Each is a separate deployment with its own keys, prices and eID. */
export const MARKETS = {
  no: "https://esigner.no/api/v1",
  dk: "https://esigner.dk/api/v1",
  se: "https://esigner.se/api/v1",
  fi: "https://esigner.fi/api/v1",
  de: "https://esigner.de/api/v1",
  nl: "https://esigner.nl/api/v1",
  uk: "https://esigner.uk/api/v1",
} as const;
export type Market = keyof typeof MARKETS;

export interface EsignerOptions {
  /** Which esigner market the key belongs to. Default `no`. Ignored when `baseUrl` is given. */
  market?: Market;
  /** Full API base, e.g. `https://esigner.no/api/v1`. For testing against a staging host. */
  baseUrl?: string;
  /** Retries after a network error, 429 or 5xx. Default 2. POSTs are safe to retry: they carry
   *  the same Idempotency-Key every attempt. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 60 000 (an upload of a large PDF can be slow). */
  timeoutMs?: number;
  /** Your own fetch, e.g. for a proxy or tests. Defaults to the global one. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Your own key for this call, to make a retry from YOUR side return the original result too. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Any non-2xx answer. `code` is the API's stable machine-readable error (see the docs' error table). */
export class EsignerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  /** The whole JSON body — some errors carry more (`unavailable`, `available`, `balanceOre`, …). */
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === "string" ? body.error : `http_${status}`;
    const detail = typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : undefined;
    super(detail ? `${code}: ${detail}` : code);
    this.name = "EsignerError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}

/** A webhook whose signature, or timestamp, did not check out. Answer such a request with 400. */
export class WebhookSignatureError extends Error {
  constructor(message: string) { super(message); this.name = "WebhookSignatureError"; }
}

export interface UploadParams {
  /** The sender's address — receipt, progress mails and the signed PDF go there. */
  ownerEmail: string;
  /** The /maler template the document was filled from, when it was. */
  templateSlug?: string;
}

/** What `documents.upload` accepts per file: a Blob/File, or bytes with a name. */
export type FileInput = Blob | { data: Uint8Array | ArrayBuffer; filename: string; contentType?: string };

/**
 * Webhook verification: an HMAC-SHA256 of `<t>.<raw body>` with your endpoint's secret (whsec_…),
 * sent as `Esigner-Signature: t=<unix>,v1=<hex>`. Pass the body EXACTLY as received — re-serialised
 * JSON will not match. Uses Web Crypto, so it works on edge runtimes too.
 */
export const Webhooks = {
  /** True when the signature matches and the timestamp is within `toleranceSec` (default 300). */
  async verify(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, toleranceSec = 300): Promise<boolean> {
    if (!header) return false;
    const parts = Object.fromEntries(header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) return false;
    if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
    const expected = await hmacHex(secret, concat(new TextEncoder().encode(`${parts.t}.`), toBytes(rawBody)));
    return timingSafeEqualHex(expected, parts.v1);
  },

  /** Verify, then parse into a typed event. Throws WebhookSignatureError when it doesn't verify. */
  async constructEvent(rawBody: string | Uint8Array, header: string | null | undefined, secret: string, toleranceSec = 300): Promise<WebhookEvent> {
    if (!(await Webhooks.verify(rawBody, header, secret, toleranceSec))) {
      throw new WebhookSignatureError("esigner webhook signature did not verify (wrong secret, a re-serialised body, or a stale timestamp)");
    }
    return JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody)) as WebhookEvent;
  },
};

export class Esigner {
  readonly documents: Documents;
  readonly signatureRequests: SignatureRequests;
  readonly balance: BalanceResource;
  readonly events: Events;
  /** Static too (`Esigner.webhooks`): verifying needs your endpoint secret, not an API key. */
  readonly webhooks = Webhooks;
  static readonly webhooks = Webhooks;

  private readonly base: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, options: EsignerOptions = {}) {
    if (!apiKey || !/^sk_(live|test)_/.test(apiKey)) {
      throw new Error("Esigner: pass an API key (sk_live_… or sk_test_…) — create one under Konto → Utvikler.");
    }
    this.base = (options.baseUrl ?? MARKETS[options.market ?? "no"]).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("Esigner: no fetch available — use Node 18+ or pass `fetch` in the options.");
    this.fetchImpl = f.bind(globalThis);
    this.documents = new Documents(this);
    this.signatureRequests = new SignatureRequests(this);
    this.balance = new BalanceResource(this);
    this.events = new Events(this);
  }

  /** @internal Every call goes through here: auth, idempotency, retries and errors in one place. */
  async request<T>(method: "GET" | "POST", path: string, opts: {
    query?: Record<string, string | number | undefined>;
    json?: unknown;
    form?: FormData;
    raw?: boolean;
  } & RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, "User-Agent": "esigner-sdk-js/0.1.0" };
    if (method === "POST") headers["Idempotency-Key"] = opts.idempotencyKey ?? randomKey();
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    const body = opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined);

    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error(`timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      const onAbort = () => ctl.abort(opts.signal?.reason);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: ctl.signal });
      } catch (err) {
        if (opts.signal?.aborted || attempt >= this.maxRetries) throw err;
        await sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
      if (res.ok) {
        if (opts.raw) return new Uint8Array(await res.arrayBuffer()) as T;
        return (await res.json()) as T;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt));
        continue;
      }
      let errBody: Record<string, unknown> = {};
      try { errBody = (await res.json()) as Record<string, unknown>; } catch { /* not JSON — keep the status */ }
      throw new EsignerError(res.status, errBody);
    }
  }
}

class Documents {
  constructor(private readonly c: Esigner) {}

  /**
   * Upload the file(s) to be signed — step one of every request. Several files are merged in the
   * order given. PDF and .docx are accepted (Word is converted to PDF on upload).
   *
   * `ownerEmail` is the sender: the receipt, progress mails and the signed PDF go there. A platform
   * sending for its own customers puts the customer's address here.
   */
  upload(files: FileInput | FileInput[], params: UploadParams, opts: RequestOptions = {}): Promise<Document> {
    const form = new FormData();
    for (const f of Array.isArray(files) ? files : [files]) {
      if (f instanceof Blob) form.append("files", f, (f as File).name ?? "document.pdf");
      else form.append("files", new Blob([ownBytes(f.data)], { type: f.contentType ?? contentTypeFor(f.filename) }), f.filename);
    }
    form.append("ownerEmail", params.ownerEmail);
    if (params.templateSlug) form.append("templateSlug", params.templateSlug);
    return this.c.request<Document>("POST", "/documents", { form, ...opts });
  }
}

class SignatureRequests {
  constructor(private readonly c: Esigner) {}

  /** Send an uploaded document for signing. */
  create(params: CreateSignatureRequestParams, opts: RequestOptions = {}): Promise<SignatureRequest> {
    return this.c.request<SignatureRequest>("POST", "/signature_requests", { json: params, ...opts });
  }

  /** Upload and send in one call — `documents.upload` then `create` with its id. */
  async createWithFiles(
    files: FileInput | FileInput[],
    params: Omit<CreateSignatureRequestParams, "documentId"> & UploadParams,
    opts: RequestOptions = {},
  ): Promise<SignatureRequest> {
    const { ownerEmail, templateSlug, ...create } = params;
    const doc = await new Documents(this.c).upload(files, { ownerEmail, templateSlug }, opts.signal ? { signal: opts.signal } : {});
    return this.create({ ...create, documentId: doc.id } as CreateSignatureRequestParams, opts);
  }

  retrieve(id: string, opts: RequestOptions = {}): Promise<SignatureRequest> {
    return this.c.request<SignatureRequest>("GET", `/signature_requests/${encodeURIComponent(id)}`, opts);
  }

  /** Stop a request before anyone has signed; whatever it drew (quota, payment) comes back. */
  cancel(id: string, params: { reason?: string } = {}, opts: RequestOptions = {}): Promise<CancelSignatureRequestResult> {
    return this.c.request("POST", `/signature_requests/${encodeURIComponent(id)}/cancel`, { json: params, ...opts });
  }

  /** The signed PDF(s) of a completed request, with their positions. */
  listSignedDocuments(id: string, opts: RequestOptions = {}): Promise<SignedDocumentList> {
    return this.c.request("GET", `/signature_requests/${encodeURIComponent(id)}/signed_documents`, opts);
  }

  /** The signed PDF's bytes. Position 0 is the merged document (or the first of several). */
  downloadSignedDocument(id: string, position = 0, opts: RequestOptions = {}): Promise<Uint8Array> {
    return this.c.request<Uint8Array>("GET", `/signature_requests/${encodeURIComponent(id)}/signed_documents/${position}`, { raw: true, ...opts });
  }
}

class BalanceResource {
  constructor(private readonly c: Esigner) {}

  retrieve(opts: RequestOptions = {}): Promise<Balance> {
    return this.c.request<Balance>("GET", "/balance", opts);
  }

  listTransactions(params: { limit?: number; cursor?: string } = {}, opts: RequestOptions = {}): Promise<Ok<"/balance/transactions", "get">> {
    return this.c.request("GET", "/balance/transactions", { query: params, ...opts });
  }

  /** Every transaction, newest first, fetching pages as you iterate. */
  allTransactions(params: { limit?: number } = {}): AsyncIterable<BalanceTransaction> {
    return paginate((cursor) => this.listTransactions({ ...params, cursor }));
  }
}

class Events {
  constructor(private readonly c: Esigner) {}

  /** The same events delivered to your webhooks, newest first — for backfilling after downtime. */
  list(params: { limit?: number; cursor?: string; type?: WebhookEventType } = {}, opts: RequestOptions = {}): Promise<Ok<"/events", "get">> {
    return this.c.request("GET", "/events", { query: params, ...opts });
  }

  /** Every event (optionally of one type), newest first, fetching pages as you iterate. */
  all(params: { limit?: number; type?: WebhookEventType } = {}): AsyncIterable<ApiEvent> {
    return paginate((cursor) => this.list({ ...params, cursor }));
  }
}

// --- helpers ---------------------------------------------------------------------------------------

async function* paginate<T>(page: (cursor: string | undefined) => Promise<{ data: T[]; next_cursor: string | null }>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const p = await page(cursor);
    for (const item of p.data) yield item;
    cursor = p.next_cursor ?? undefined;
  } while (cursor);
}

function randomKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.min(60_000, s * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(60_000, at - Date.now()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function contentTypeFor(filename: string): string {
  return /\.docx$/i.test(filename)
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

/** A copy on a plain ArrayBuffer — what Blob and Web Crypto accept (never a SharedArrayBuffer view). */
function ownBytes(v: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(v.byteLength);
  out.set(v instanceof Uint8Array ? v : new Uint8Array(v));
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function subtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Node 18 has Web Crypto, but not on globalThis by default.
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto.subtle as unknown as SubtleCrypto;
}

async function hmacHex(secret: string, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const s = await subtle();
  const key = await s.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await s.sign("HMAC", key, data));
  return Array.from(sig, (x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
