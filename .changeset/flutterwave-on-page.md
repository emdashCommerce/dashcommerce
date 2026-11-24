---
"@dashcommerce/flutterwave": minor
---

On-page checkout with Flutterwave Inline.

- Declares `checkoutStyles: ["hosted", "on_page"]` and a `publicKey` credential (`FLWPUBK_…`), saved by core as `settings:flutterwavePublicKey`.
- With checkout set to "On your page", `initCheckout` returns `on_page` with the public key, `tx_ref`, amount in major units and customer details. No server-side payment is created; Inline creates the transaction in the browser.
- New `./checkout-client` entry registers Flutterwave Inline on `window.DashCommerceCheckoutClients.flutterwave`, loads `checkout.flutterwave.com/v3.js` only when the customer presses Pay, and maps `callback`/`onclose` to finished/closed. Orders still come only from the signed webhook and the live verify.
- On-page checkout refuses to start, with a message naming the setting, when the public key is missing.
