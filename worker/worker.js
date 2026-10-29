// newsletter-ai Worker
// OpenAI Chat Completions API を呼び出すサーバーサイドプロキシ

const ALLOWED_ORIGIN = "https://hipchin.github.io";
const MAX_CONTENT_CHARS = 6000;
const MAX_TOKENS = 800;
const MODEL = "gpt-4o-mini";

// [SECURITY] 利用の合言葉(シークレット APP_KEY)を送るヘッダー。
// Origin は curl 等で偽装できるため、合言葉を知っている人だけが OpenAI API を使えるようにする。
// 合言葉はユーザーが端末で一度だけ入力して保存する。配信物・Git・ログには入れない。
const APP_KEY_HEADER = "x-app-key";

// [SECURITY] リクエストボディのサイズ上限（約50KB）
const MAX_REQUEST_BYTES = 50_000;

// [SECURITY] historyの制限
const MAX_HISTORY_TURNS = 10;    // 最大10往復（user+assistantで20メッセージ）
const MAX_MESSAGE_CHARS = 2000;  // 1メッセージあたりの文字数上限

const SYSTEM_PROMPT = `あなたはメルマガの内容について一緒に考える思考パートナーです。
ユーザーが提示した記事に基づいて、簡潔かつ具体的に答えてください。
回答は日本語で、必要以上に長くしないでください。`;

const MODE_PROMPTS = {
  要約:  "この記事の要点を3〜5行で要約してください。",
  論点:  "この記事の主な論点・主張を整理してください。",
  疑問点: "この記事を読んで生じる疑問点や不明点を挙げてください。",
  反論:  "この記事の主張に対してありうる反論を考えてください。",
  応用:  "この記事の内容を自分の仕事や日常に応用するとしたら、どのような示唆が得られますか？",
};

export default {
  async fetch(request, env) {

    // [SECURITY] Originチェック
    // CORSヘッダーだけではWorkerへの直接POSTを防げないため、
    // Originヘッダーが許可ドメイン以外なら403を返す。
    // （curl等のツールからの直接呼び出し対策）
    const origin = request.headers.get("Origin") || "";
    if (origin !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/ai") {
      return corsResponse(JSON.stringify({ error: "Not found" }), 404);
    }

    // [SECURITY] 接続元IPごとの回数制限。合言葉の総当たりも防ぐため、確認より前にかける
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return corsResponse(JSON.stringify({ error: "短時間にリクエストが集中しています。1分ほど待ってから再試行してください。" }), 429);
      }
    }

    // [SECURITY] 合言葉の確認。シークレット未設定のときは受け付けない側に倒す
    if (!env.APP_KEY) {
      return corsResponse(JSON.stringify({ error: "サーバーの設定が不完全です" }), 503);
    }
    if (!(await sameSecret(normalizeKey(request.headers.get(APP_KEY_HEADER), true), normalizeKey(env.APP_KEY, false)))) {
      return corsResponse(JSON.stringify({ error: "unauthorized" }), 401);
    }

    // [SECURITY] リクエストサイズ制限
    // Content-Lengthヘッダーと実際のボディサイズの両方をチェック
    const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (contentLength > MAX_REQUEST_BYTES) {
      return corsResponse(JSON.stringify({ error: "リクエストサイズが大きすぎます" }), 413);
    }
    const rawBody = await request.text();
    if (rawBody.length > MAX_REQUEST_BYTES) {
      return corsResponse(JSON.stringify({ error: "リクエストサイズが大きすぎます" }), 413);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return corsResponse(JSON.stringify({ error: "Invalid JSON" }), 400);
    }

    const { mode, title, content, question, history } = body;

    if (!title || !content) {
      return corsResponse(JSON.stringify({ error: "title と content は必須です" }), 400);
    }

    // 本文が長すぎる場合は切り詰める
    const trimmedContent = content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS) + "\n\n[※本文が長いため途中までを対象にしています]"
      : content;

    // 記事コンテキストをシステムプロンプトに付加
    const systemWithArticle = SYSTEM_PROMPT
      + `\n\n---\n【記事タイトル】${title}\n【記事本文】\n${trimmedContent}\n---`;

    // 今回のユーザー発言を確定
    const userMessage = (mode && MODE_PROMPTS[mode])
      ? MODE_PROMPTS[mode]
      : (question || "この記事について教えてください");

    // [SECURITY] historyのサニタイズ
    // - user / assistant のみ許可（system等の不正roleを除外）
    // - contentが文字列でないものを除外
    // - 末尾からMAX_HISTORY_TURNS往復分のみ使用（古い履歴は切り捨て）
    // - 1メッセージあたりMAX_MESSAGE_CHARS文字に切り詰め
    const sanitizedHistory = (Array.isArray(history) ? history : [])
      .filter(m => m.role === "user" || m.role === "assistant")
      .filter(m => typeof m.content === "string")
      .slice(-(MAX_HISTORY_TURNS * 2))
      .map(m => ({
        role: m.role,
        content: m.content.slice(0, MAX_MESSAGE_CHARS),
      }));

    const messages = [
      ...sanitizedHistory,
      { role: "user", content: userMessage },
    ];

    // OpenAI API呼び出し
    let aiText;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: systemWithArticle },
            ...messages,
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error("OpenAI error:", err);
        return corsResponse(JSON.stringify({ error: "OpenAI APIエラー: " + res.status }), 502);
      }

      const json = await res.json();
      aiText = json.choices?.[0]?.message?.content || "(応答なし)";

    } catch (e) {
      console.error(e);
      return corsResponse(JSON.stringify({ error: "サーバーエラーが発生しました" }), 500);
    }

    return corsResponse(JSON.stringify({ reply: aiText }), 200);
  }
};

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": `Content-Type, ${APP_KEY_HEADER}`,
    },
  });
}

// 日本語の合言葉も使えるよう、画面側は encodeURIComponent してヘッダーに載せる(ヘッダーは ASCII しか送れない)。
// ここで元に戻し、Unicode 正規化と前後の空白除去をそろえてから比べる。
function normalizeKey(value, encoded) {
  let s = value || "";
  if (encoded) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // 不正な % 表記はそのまま比べる(一致しないので拒否される)
    }
  }
  return s.normalize("NFC").trim();
}

// 長さや一致した位置が処理時間に出ないよう、ハッシュ同士を定数時間で比べる
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
