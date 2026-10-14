<p align="center">
  <a href="https://esigner.no">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/esigner-me/esigner-sdk-php/main/art/esigner-mark.svg">
      <img src="https://esigner.no/logo.svg" alt="esigner" height="64">
    </picture>
  </a>
</p>

<h1 align="center">esigner SDK for JavaScript &amp; TypeScript</h1>

<p align="center">Send PDFs for signing with BankID, MitID and other national eIDs, get the signed PDF back, and verify webhooks — from Node.js, Bun, Deno or the edge.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@esigner/sdk"><img src="https://img.shields.io/npm/v/@esigner/sdk" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933" alt="Node 18+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license">
</p>

<p align="center">
  <a href="https://esigner.no/dokumentasjon"><b>API reference</b></a> ·
  <a href="https://esigner.no">esigner.no</a> ·
  <a href="https://esigner.dk">esigner.dk</a> ·
  <a href="https://esigner.se">esigner.se</a> ·
  <a href="https://esigner.fi">esigner.fi</a> ·
  <a href="https://esigner.de">esigner.de</a> ·
  <a href="https://esigner.me">esigner.me</a>
</p>

- Fully typed, generated from the API's own OpenAPI spec
- No dependencies — Node 18+, Bun, Deno and edge runtimes
- Safe retries: every POST carries an idempotency key that stays the same across retries
- Webhook verification in one call


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

Using another market? `new Esigner(key, { market: "se" })` — see the table below.

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

## esigner around the world

esigner runs one site per country, each signing with that country's own eID. An API key belongs to
the site it was created on — pick it with the `market` option.

| | Site | Signers identify with | API reference |
|---|---|---|---|
| 🇳🇴 Norway | [esigner.no](https://esigner.no) | BankID | [esigner.no/dokumentasjon](https://esigner.no/dokumentasjon) |
| 🇩🇰 Denmark | [esigner.dk](https://esigner.dk) | MitID | [esigner.dk/dokumentation](https://esigner.dk/dokumentation) |
| 🇸🇪 Sweden | [esigner.se](https://esigner.se) | BankID | [esigner.se/dokumentation](https://esigner.se/dokumentation) |
| 🇫🇮 Finland | [esigner.fi](https://esigner.fi) | Bank credentials (FTN) | [esigner.fi/dokumentaatio](https://esigner.fi/dokumentaatio) |
| 🇩🇪 Germany | [esigner.de](https://esigner.de) | Personalausweis | [esigner.de/dokumentation](https://esigner.de/dokumentation) |

📱 **On the go:** [esigner.me](https://esigner.me) — the esigner app for iPhone and Android. Scan or
upload a document, send it for signing and follow it until everyone has signed.

PHP or WordPress? The same SDK exists for Composer: [`esigner/sdk`](https://packagist.org/packages/esigner/sdk).

## License

MIT
