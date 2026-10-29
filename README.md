# newsletter-reader
## AI機能のWorker(`worker/`)

「AIと話す」は Cloudflare Worker `broad-scene-f489` 経由で OpenAI API を呼ぶ。Worker のコードは `worker/` にある。

- Origin のチェックは curl 等で偽装できるため、利用の合言葉(シークレット `APP_KEY`)と接続元IPごとの回数制限(10回/分)をかけている。`APP_KEY` が未設定だと全リクエストを拒否する。
- 画面では初回だけ合言葉を入力して「保存」を押す。Worker の `/api/check-key` で合言葉だけを確認し(OpenAI API は呼ばない)、その端末の localStorage に保存される。

```bash
cd worker
wrangler secret put APP_KEY   # 推測されにくい文字列(例: openssl rand -base64 18 の出力)
wrangler deploy
npm test
```
