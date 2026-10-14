# @esigner/sdk

The official JavaScript/TypeScript client for the [esigner](https://esigner.no) API: send PDFs for
signing with BankID, MitID and other national eIDs, get the signed PDF back, and verify webhooks.

- Fully typed, generated from the API's own OpenAPI spec
- No dependencies — Node 18+, Bun, Deno and edge runtimes
- Safe retries: every POST carries an idempotency key that stays the same across retries
- Webhook verification in one call

Full API reference: **https://esigner.no/dokumentasjon**

## Install

```sh
npm install @esigner/sdk
```

Create an API key under **Konto → Utvikler** on your esigner site. Keys starting with `sk_test_`
sign against the test environment: the real flow, with test identities, no payment and no legally
binding signature.

## Send a document for signing

```ts
import { readFile } from "node:fs/promises";
import { Esigner } from "@esigner/sdk";

const esigner = new Esigner(process.env.ESIGNER_API_KEY!);   // market: "no" by default

const request = await esigner.signatureRequests.createWithFiles(
  { data: await readFile("contract.pdf"), filename: "contract.pdf" },
  {
    ownerEmail: "post@company.no",          // receives the receipt and the signed PDF
    signers: [
      { name: "Ola Nordmann", email: "ola@example.no" },
      { name: "Kari Nordmann", email: "kari@example.no" },
    ],
    useSubscription: true,                  // draw from your plan's quota
    signingEids: ["no_bankid"],             // optional: Norwegian BankID only
    returnUrl: "https://app.example.com/contracts/123/signed",  // optional: where signers land after
  },
);

console.log(request.id, request.signers.map((s) => s.sign_url));
```

Other markets: `new Esigner(key, { market: "se" })` — `no`, `dk`, `se`, `fi`, `de`, `nl`, `uk`. A key
belongs to the market it was created in.

## Get the signed PDF

```ts
const signed = await esigner.signatureRequests.retrieve(request.id);
if (signed.status === "completed") {
  const pdf = await esigner.signatureRequests.downloadSignedDocument(request.id);  // Uint8Array
}
```

Or cancel before anyone has signed — whatever the request drew comes back:

```ts
await esigner.signatureRequests.cancel(request.id, { reason: "Wrong version" });
```

## Webhooks

esigner signs every delivery with `Esigner-Signature: t=<unix>,v1=<hmac>`. Verify it against the
**raw** request body — a re-serialised JSON body will not match.

```ts
import express from "express";
import { Esigner, WebhookSignatureError } from "@esigner/sdk";

app.post("/webhooks/esigner", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await Esigner.webhooks.constructEvent(
      req.body,                                   // Buffer — the raw body
      req.header("Esigner-Signature"),
      process.env.ESIGNER_WEBHOOK_SECRET!,        // whsec_…
    );
    switch (event.type) {
      case "signer.signed":      console.log(`${event.data.signersSigned}/${event.data.signersTotal} signed`); break;
      case "document.completed": /* fetch the signed PDF */ break;
    }
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return res.sendStatus(400);
    throw err;
  }
});
```

Events: `signer.signed`, `signer.declined`, `document.completed`, `document.cancelled`,
`document.signing_failed`, `order.captured`. Deliveries are retried; dedupe on `event.id`. Missed
some? Read them back:

```ts
for await (const event of esigner.events.all({ type: "document.completed" })) { /* … */ }
```

## Errors

Any non-2xx answer throws an `EsignerError` with the API's stable `code`:

```ts
import { EsignerError } from "@esigner/sdk";

try {
  await esigner.signatureRequests.create({ /* … */ });
} catch (err) {
  if (err instanceof EsignerError && err.code === "quota_exceeded") { /* … */ }
}
```

`err.status`, `err.detail` and the full JSON `err.body` are there too. Network errors, `429` and
`5xx` are retried twice with backoff (`maxRetries` to change it).

## Options

```ts
new Esigner(key, {
  market: "no",        // which esigner site the key belongs to
  baseUrl: undefined,  // or a full API base, e.g. a staging host
  maxRetries: 2,
  timeoutMs: 60_000,
  fetch: undefined,    // bring your own fetch
});
```

Every POST accepts `{ idempotencyKey }` as its last argument, to make a retry from your side return
the original result too.

## License

MIT
