import assert from "node:assert/strict";
import test from "node:test";
import {
  createAllSecureSignature,
  verifyAllSecureCallback,
} from "../src/services/allsecure.service.js";

test("creates the documented AllSecure V3 HMAC-SHA512 signature", () => {
  const signature = createAllSecureSignature({
    method: "POST",
    body: '{"merchantTransactionId":"2019-09-02-0004","amount":"9.99","currency":"EUR"}',
    contentType: "application/json; charset=utf-8",
    date: "Tue, 21 Jul 2020 13:15:03 UTC",
    requestUri: "/api/v3/transaction/my-api-key/debit",
    sharedSecret: "my-shared-secret",
  });

  assert.equal(
    signature,
    "nL+8FBKWx4/pahYScKs/dRYPBEWjiBalRaWKHGtxLpELmLrgJ/+dSWjt6dZNuu6oF18NyWEU8tXLEVm2mtEapg=="
  );
});

test("accepts a current authentic callback and rejects tampering", () => {
  const oldSecret = process.env.ALLSECURE_SHARED_SECRET;
  const oldApiKey = process.env.ALLSECURE_API_KEY;
  const oldUsername = process.env.ALLSECURE_USERNAME;
  const oldPassword = process.env.ALLSECURE_PASSWORD;
  process.env.ALLSECURE_SHARED_SECRET = "callback-secret";
  process.env.ALLSECURE_API_KEY = "test-key";
  process.env.ALLSECURE_USERNAME = "test-user";
  process.env.ALLSECURE_PASSWORD = "test-password";

  try {
    const now = Date.now();
    const date = new Date(now).toUTCString();
    const body = '{"result":"OK","merchantTransactionId":"DMNE-1"}';
    const request = {
      method: "POST",
      body,
      contentType: "application/json; charset=utf-8",
      date,
      requestUri: "/api/v1/payments/allsecure/callback",
      sharedSecret: "callback-secret",
    };
    const signature = createAllSecureSignature(request);

    assert.equal(verifyAllSecureCallback({ ...request, signature, now }), true);
    assert.equal(verifyAllSecureCallback({ ...request, body: `${body} `, signature, now }), false);
  } finally {
    if (oldSecret === undefined) delete process.env.ALLSECURE_SHARED_SECRET;
    else process.env.ALLSECURE_SHARED_SECRET = oldSecret;
    if (oldApiKey === undefined) delete process.env.ALLSECURE_API_KEY;
    else process.env.ALLSECURE_API_KEY = oldApiKey;
    if (oldUsername === undefined) delete process.env.ALLSECURE_USERNAME;
    else process.env.ALLSECURE_USERNAME = oldUsername;
    if (oldPassword === undefined) delete process.env.ALLSECURE_PASSWORD;
    else process.env.ALLSECURE_PASSWORD = oldPassword;
  }
});
