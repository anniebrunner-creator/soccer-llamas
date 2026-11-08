# Deploy on Render

1. Sign in at https://render.com with GitHub.
2. New → **Web Service** → pick `anniebrunner-creator/soccer-llamas`.
3. Runtime: **Node** · Build command: `npm install` · Start command: `npm start`
4. Environment variables:
   - `DEMO=1` (public click-around demo)
   - `PORT` is set by Render automatically; no need to add it.
5. Deploy. With `DEMO=1` the captain demo key is `demo-captain` (open `/admin?key=demo-captain`).

Note: data is stored in `data/` on local disk, which is ephemeral on Render's free tier (resets on redeploy/restart).

Out notes ("Why can’t you make it?") are optional and may be blank. On this demo they are **not private**: `DEMO=1` publishes the captain key `demo-captain`, and the captain attendance page is part of the public click-around. Players are made up. Do not enter real health information. Notes do not change points, reminders, or injury reserve.
