import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";

import worker from "./worker.js";

// Workers にだけある crypto.subtle.timingSafeEqual をテスト用に補う
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const origin = "https://hipchin.github.io";
const appKey = "test-app-key";

function request(key = appKey) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (key !== null) headers["x-app-key"] = key;
  return new Request("https://worker.example.com/api/ai", {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "要約", title: "タイトル", content: "本文", history: [] }),
  });
}

function env() {
  return { OPENAI_API_KEY: "test-openai-key", APP_KEY: appKey };
}

function stubFetch(t, impl) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = impl;
}

test("calls OpenAI and returns the reply when the app key matches", async (t) => {
  stubFetch(t, async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    return Response.json({ choices: [{ message: { content: "要約です" } }] });
  });

  const response = await worker.fetch(request(), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "要約です" });
});

test("rejects a wrong or missing app key before calling OpenAI", async (t) => {
  stubFetch(t, async () => {
    throw new Error("OpenAI must not be called");
  });

  for (const key of ["wrong-key", "", null]) {
    const response = await worker.fetch(request(key), env());
    assert.equal(response.status, 401);
  }
});

test("refuses requests when APP_KEY is not configured", async (t) => {
  stubFetch(t, async () => {
    throw new Error("OpenAI must not be called");
  });

  const response = await worker.fetch(request(), { ...env(), APP_KEY: "" });
  assert.equal(response.status, 503);
});

test("counts requests against the rate limit before checking the app key", async () => {
  const calls = [];
  const limiter = {
    async limit({ key }) {
      calls.push(key);
      return { success: false };
    },
  };

  const response = await worker.fetch(request("wrong-key"), { ...env(), RATE_LIMITER: limiter });
  assert.equal(response.status, 429);
  assert.equal(calls.length, 1);
});

test("still rejects other origins", async () => {
  const req = new Request("https://worker.example.com/api/ai", {
    method: "POST",
    headers: { Origin: "https://evil.example.com", "x-app-key": appKey },
    body: "{}",
  });
  const response = await worker.fetch(req, env());
  assert.equal(response.status, 403);
});

test("allows the app key header in CORS preflight", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example.com/api/ai", { method: "OPTIONS", headers: { Origin: origin } }),
    env()
  );
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /x-app-key/);
});

test("accepts a Japanese app key sent URI-encoded", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) =>
    String(url).includes("openai")
      ? Response.json({ choices: [{ message: { content: "ok" } }] })
      : Response.json({ content: "ok", lang: "ja", availableLangs: ["ja"] });

  const okEnv = { ...env(), APP_KEY: " にほんごの合言葉 " };
  assert.equal((await worker.fetch(request(encodeURIComponent("にほんごの合言葉")), okEnv)).status, 200);
  assert.equal((await worker.fetch(request(encodeURIComponent("ちがう合言葉")), okEnv)).status, 401);
});
