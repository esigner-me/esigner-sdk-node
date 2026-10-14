import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Esigner, EsignerError, WebhookSignatureError, MARKETS, type WebhookEventType } from "../src/index.js";

type Call = { url: URL; init: RequestInit };

/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    const next = answers.shift();
    if (!next) throw new Error("no more scripted answers");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("requests", () => {
  it("calls the market's API with the key, JSON body and an idempotency key", async () => {
    const { f, calls } = fakeFetch([json(201, { id: "req_1", status: "in_progress" })]);
    const es = new Esigner("sk_test_abc", { market: "se", fetch: f });
    const r = await es.signatureRequests.create({ documentId: "doc_1", signers: [{ email: "a@example.se" }], signingEids: ["se_bankid"] });
    expect(r.id).toBe("req_1");
    expect(calls[0]!.url.href).toBe(`${MARKETS.se}/signature_requests`);
    expect(header(calls[0]!, "authorization")).toBe("Bearer sk_test_abc");
    expect(header(calls[0]!, "idempotency-key")).toMatch(/.{16,}/);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ documentId: "doc_1", signingEids: ["se_bankid"] });
  });

  it("retries a 503 and a network error with the SAME idempotency key, then succeeds", async () => {
    const { f, calls } = fakeFetch([json(503, { error: "maintenance" }), new TypeError("fetch failed"), json(201, { id: "req_2" })]);
    const es = new Esigner("sk_test_abc", { fetch: f, maxRetries: 2 });
    expect((await es.signatureRequests.create({ documentId: "d", signers: [{ email: "a@x.no" }] })).id).toBe("req_2");
    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map((c) => header(c, "idempotency-key")));
    expect(keys.size).toBe(1);
  }, 15_000);

  it("does not retry a 4xx, and surfaces the API's code and body", async () => {
    const { f, calls } = fakeFetch([json(400, { error: "signing_eid_unavailable", unavailable: ["dk_mitid"], available: ["no_bankid"] })]);
    const es = new Esigner("sk_test_abc", { fetch: f });
    const err = await es.signatureRequests.create({ documentId: "d", signers: [{ email: "a@x.no" }], signingEids: ["dk_mitid"] }).catch((e) => e);
    expect(err).toBeInstanceOf(EsignerError);
    expect(err).toMatchObject({ status: 400, code: "signing_eid_unavailable" });
    expect(err.body.available).toEqual(["no_bankid"]);
    expect(calls).toHaveLength(1);
  });

  it("refuses something that is not an API key, before any network call", () => {
    expect(() => new Esigner("whsec_oops")).toThrow(/API key/);
  });

  it("uploads files as multipart under `files`, in order", async () => {
    const { f, calls } = fakeFetch([json(200, { id: "doc_9", filename: "a.pdf", sizeBytes: 3, attachments: [] })]);
    const es = new Esigner("sk_live_abc", { fetch: f });
    await es.documents.upload([{ data: new Uint8Array([1, 2, 3]), filename: "a.pdf" }, { data: new Uint8Array([4]), filename: "b.docx" }], { ownerEmail: "post@klubb.se" });
    const form = calls[0]!.init.body as FormData;
    const files = form.getAll("files") as File[];
    expect(files.map((x) => x.name)).toEqual(["a.pdf", "b.docx"]);
    expect(files[1]!.type).toContain("wordprocessingml");
    expect(form.get("ownerEmail")).toBe("post@klubb.se");
  });

  it("downloads the signed PDF as bytes", async () => {
    const { f } = fakeFetch([new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "Content-Type": "application/pdf" } })]);
    const pdf = await new Esigner("sk_live_abc", { fetch: f }).signatureRequests.downloadSignedDocument("req_1");
    expect(new TextDecoder().decode(pdf)).toBe("%PDF");
  });

  it("walks every page of events through next_cursor", async () => {
    const { f, calls } = fakeFetch([
      json(200, { data: [{ id: "e1" }, { id: "e2" }], next_cursor: "c2" }),
      json(200, { data: [{ id: "e3" }], next_cursor: null }),
    ]);
    const ids: string[] = [];
    for await (const e of new Esigner("sk_live_abc", { fetch: f }).events.all({ type: "signer.signed" })) ids.push(e.id);
    expect(ids).toEqual(["e1", "e2", "e3"]);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("c2");
    expect(calls[0]!.url.searchParams.get("type")).toBe("signer.signed");
  });
});

describe("webhooks", () => {
  // Signed exactly as api/src/webhooks/events.ts signs a delivery.
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "signer.signed", livemode: false, created: 1, data: { signersSigned: 1, signersTotal: 3 } });
  const sign = (t: number, b = body) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")}`;
  const now = () => Math.floor(Date.now() / 1000);

  it("verifies a genuine delivery, as a string or as bytes", async () => {
    expect(await Esigner.webhooks.verify(body, sign(now()), secret)).toBe(true);
    expect(await Esigner.webhooks.verify(new TextEncoder().encode(body), sign(now()), secret)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and a missing header", async () => {
    expect(await Esigner.webhooks.verify(body + " ", sign(now()), secret)).toBe(false);
    expect(await Esigner.webhooks.verify(body, sign(now()), "whsec_other")).toBe(false);
    expect(await Esigner.webhooks.verify(body, sign(now() - 3600), secret)).toBe(false);
    expect(await Esigner.webhooks.verify(body, null, secret)).toBe(false);
  });

  it("constructEvent returns the typed event, or throws", async () => {
    const e = await Esigner.webhooks.constructEvent(body, sign(now()), secret);
    expect(e.type).toBe("signer.signed");
    if (e.type === "signer.signed") expect(e.data.signersTotal).toBe(3);
    await expect(Esigner.webhooks.constructEvent(body, sign(now()), "whsec_other")).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("knows exactly the event types the API documents", () => {
    // WebhookEvent's union is written by hand; this keeps it equal to the spec's list.
    const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as { "x-webhook-events": { type: string }[] };
    const known: Record<WebhookEventType, true> = {
      "document.completed": true, "document.signing_failed": true, "document.cancelled": true,
      "signer.signed": true, "signer.declined": true, "order.captured": true,
    };
    expect(Object.keys(known).sort()).toEqual(spec["x-webhook-events"].map((e) => e.type).sort());
  });
});
