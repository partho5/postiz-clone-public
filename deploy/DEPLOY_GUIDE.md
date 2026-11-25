# Deploy guide (for Claude Code on the VPS, or an operator)

Task: deploy this repository to this server for production, from the CI-built image, on a 2 GB box.
Read this whole file, then execute it top to bottom. It is a **deploy task, not a build task**: ignore
and do not edit source code.
Reference for the pieces: [README.md](README.md).

## Rules for the assistant

- Never print, log, commit or paste a secret (passwords, API keys, `JWT_SECRET`). `deploy/.env` is
  git-ignored; keep it that way (`chmod 600 deploy/.env`).
- Never invent a value the operator owns (domain, Mailgun, PayPal, R2 keys). Ask for it, once, in a
  single message listing everything missing (section 3). Generate the secrets you can generate.
- Do not skip a check, and do not mark the deploy done until section 5 passes. If a step fails, show
  the failing command's output, say what it means, fix it if the table in section 7 covers it, otherwise
  stop and ask.
- Never run `docker compose down -v`, `docker volume rm`, `docker system prune` or anything that
  deletes volumes: they hold the database.
- Do not change tracked files under `deploy/` on the server (the next deploy refuses to run): change them in the
  repo. Only `deploy/.env` is edited on the server.

## 1. Preflight

Debian or Ubuntu, amd64, at least 20 GB free on `/`, root access (`sudo`). Bootstrap checks these itself and stops
with the reason. Decide the domain before starting: the phone app's base URL is `https://<DOMAIN>/api`, so it is
chosen once. Its DNS A record must point at this server (behind Cloudflare: point it there and use the server's IP
for `DEPLOY_HOST`).

## 2. Run bootstrap

```sh
curl -fsSL https://raw.githubusercontent.com/partho5/postiz-clone-public/main/deploy/scripts/bootstrap.sh -o bootstrap.sh
sudo sh bootstrap.sh --domain <DOMAIN> --email <operator email>
```

Options: `--user` (deploy user, default the sudo user), `--dir` (default `/var/www/smm`), `--tier` (default from the
RAM: under 3 GB `2gb`, under 6 GB `4gb`, else `8gb`), `--repo` (another fork). It installs git and Docker, adds swap,
creates the user, checks out `deploy/`, writes `deploy/.env` (chmod 600) with every secret it can generate, picks the
edge (the host's nginx when one is running, with a site and a certbot certificate; else Caddy on 80/443), and adds
the CI deploy key.

It prints, once, the CI deploy key and the values for GitHub. Hand them to the operator **without pasting the
private key anywhere else**: secrets `DEPLOY_SSH_KEY` and `DEPLOY_HOST`, variables `DEPLOY_USER` and `DEPLOY_URL`
(repository > Settings > Secrets and variables > Actions). It also prints the paid-features public key `k1=...` for
the phone app's `ENTITLEMENT_PUBLIC_KEYS`; that one is public.

## 3. Ask the operator for these, in one message

Bootstrap ends by listing the `<-- FILL` keys still open in `deploy/.env`:

| Value | Used for |
|---|---|
| `DOMAIN` | public name, e.g. `app.example.com`. DNS A record must already point at this server. The phone app's base URL is `https://<DOMAIN>/api`, so this is chosen once. |
| image tag | `APP_IMAGE` in env.example is `ghcr.io/partho5/postiz-clone-public:latest`. Ask if a pinned tag (`v1.2.3` or a short sha) or another owner is wanted. |
| Mailgun | `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (verified sending domain), `MAILGUN_REGION` (`us`/`eu`), `EMAIL_FROM_ADDRESS` on that domain. Without it nobody can sign in. |
| PayPal | `PAYPAL_MODE` (`live` or `sandbox`; picks `https://api-m.paypal.com` or `https://api-m.sandbox.paypal.com`, `PAYPAL_API_BASE` overrides it), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, all from an app of that mode |
| Cloudflare R2 | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_KEY`, `CLOUDFLARE_SECRET_ACCESS_KEY`, `CLOUDFLARE_BUCKETNAME`, `CLOUDFLARE_BUCKET_URL` |
| optional | `OPENAI_API_KEY`, `META_MUSE_API_KEY` (AI captions and content plan: a Meta Model API key from https://dev.meta.ai; empty = only those features answer 503) and channel OAuth keys (names in the repo-root `.env.example`) |

Write them into `deploy/.env` (never print them back), then run the same bootstrap command again: it does the first
deploy through `deploy/scripts/remote-deploy.sh`, exactly as CI will later, and ends with `deploy: ok (<tier>)`. The
first start can take 2 to 4 minutes. Do not add `MAILGUN_API_BASE` or `CADDY_*_PORT`: those are for local runs only.

## 4. Check the stack

```sh
docker ps --format '{{.Names}} {{.Status}}'      # app caddy postgres redis temporal, all Up
docker exec app pm2 jlist | docker exec -i app node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("["))).map(p=>p.name+" "+p.pm2_env.status+" restarts="+p.pm2_env.restart_time).join("\n")))'
```

`backend`, `orchestrator` and `frontend` must be `online` with `restarts=0`. A restart count that
keeps rising is a crash loop: show `docker logs --tail 80 app` and use section 7.

## 5. Acceptance (all must pass)

```sh
D=<DOMAIN>
curl -sI https://$D/ | head -1                                   # HTTP/2 307 (redirect to sign-in), or 200
curl -s -o /dev/null -w '%{http_code}\n' https://$D/api/         # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$D/api/auth/otp/request \
  -H 'content-type: application/json' -d '{"email":"<operator email>"}'   # 204
```

Then ask the operator to read the six-digit code from that mailbox and run:

```sh
curl -s -X POST https://$D/api/auth/token -H 'content-type: application/json' \
  -d '{"grant_type":"email_otp","email":"<operator email>","code":"<code>","device_name":"deploy-check"}'
```

It must return `access_token` and `refresh_token` (200). Do not print the tokens; report only the
status. That proves DNS, TLS, Caddy, the API, the database and Mailgun together. If the 204 comes
but no mail arrives, check `docker logs app 2>&1 | grep -i mail` (Mailgun refusal shows as
`Mailgun answered <status>`), then the Mailgun domain and key.

Mailgun needs these DNS records on the sending domain (`MAILGUN_DOMAIN`, e.g. `mg.example.com`) before
mail reaches inboxes; Mailgun's dashboard shows the exact values under Sending -> Domain settings:

| Record | Where | Purpose |
|---|---|---|
| TXT (SPF) | the sending domain | `v=spf1 include:mailgun.org ~all` |
| TXT (DKIM) | `<selector>._domainkey.<sending domain>` | Mailgun gives the selector and key |
| MX | the sending domain | only if replies to that domain must be received |
| CNAME (tracking) | `email.<sending domain>` | optional, only for click and open tracking |
| TXT (DMARC) | `_dmarc.<sending domain>` | start with `v=DMARC1; p=none; rua=mailto:<operator mailbox>` |

Use the EU values when `MAILGUN_REGION=eu`. In production the app refuses to start when `EMAIL_PROVIDER` is
`log` or unset, or when `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_FROM_NAME` or `EMAIL_FROM_ADDRESS` is
missing, so a wrong `.env` shows up as a crashing `app` container (`docker logs app`), not as silent no-mail.
The sign-in mail has the subject `<code> is your <EMAIL_FROM_NAME> sign-in code` and a body with the code,
that it works once and expires in ten minutes; it has no link. The same address can ask for a new code every
30 seconds (`OTP_RESEND_COOLDOWN_SECONDS`).

To run the whole phone flow against the server (request code, exchange, authed calls, refresh, revoke):

```sh
node deploy/scripts/e2e-auth.mjs https://<DOMAIN>/api <operator email>
```

The operator must also add the PayPal webhook: URL `https://<DOMAIN>/api/payment/paypal`, with the
webhook id placed in `PAYPAL_WEBHOOK_ID`. After changing `deploy/.env`, run `deploy/scripts/deploy.sh 2gb`
again.

## 6. Start the 72-hour soak

```sh
tmux new -d -s soak 'deploy/scripts/soak.sh 72 2gb'     # or: nohup deploy/scripts/soak.sh 72 2gb &
```

It samples every minute for 72 hours and then writes `deploy/soak/soak-<date>-2gb.md`
(peak memory per service, OOM kills, restarts, kernel log) and prints PASS, FAIL or UNKNOWN. When it
ends, commit that `.md` file (not the `.csv`) and tell the operator the result. A FAIL (exit 1) means
the 2 GB tier did not hold: send the summary and `docker logs --tail 200 app` to the developer; do not
"fix" it by editing limits on the server. UNKNOWN (exit 2, `n/a` in the OOM, pm2 or kernel log line)
means a counter could not be read, so the run shows nothing: report it as not passed, with the summary,
and do not call it a pass.

Run it as root: it reads the kernel log with `dmesg`, which a non-root user cannot read where
`kernel.dmesg_restrict=1` (Ubuntu's default), so start it from `sudo -i` (or run
`sudo sysctl kernel.dmesg_restrict=0` once). It checks this before the first sample and does not
start (exit 2, "NOT STARTED", no sample) when `dmesg` fails or already holds an out-of-memory message
from before the run: reboot the host, or `sudo dmesg -C`, and start again. Restart and OOM-killed
flags count from container creation, so a rerun after a FAIL needs freshly created containers:
`docker compose -f deploy/docker-compose.yaml --env-file deploy/tiers/2gb.env --env-file deploy/.env up -d --force-recreate`
(keeps the volumes).

## 7. If something fails

| Symptom | Cause and fix |
|---|---|
| `deploy: ... still holds a placeholder` | A `change-me` or `app.example.com` is left in `deploy/.env`. Fill it. |
| `TEMPORAL_DB_USER must not equal a Temporal database name` | Use `temporal_app`, not `temporal`. On an existing database the role was already created under the old name: ask before changing. |
| `pull access denied` / `unauthorized` | Image is private: `echo <token> | docker login ghcr.io -u <github-user> --password-stdin` (a token with `read:packages`), or the tag does not exist: check `APP_IMAGE`. |
| `migration failed; the app was not started` | Read the lines above it. The database is left as it was before the failing migration. Do not retry in a loop; show the output and stop. |
| `the app did not answer within 180s` | `docker logs --tail 120 app`. Look for a missing variable or `heap out of memory`. Out of memory on a 2 GB box: check `free -m` and `swapon --show` (swap must be active). |
| Caddy has no certificate / browser TLS error | DNS does not point here yet, or 80/443 are blocked. `docker logs caddy`. |
| `Conflict. The container name "/redis" is already in use` | A stopped container of another project has that name. `docker ps -a`, show it to the operator, rename it (`docker rename`) rather than delete it. |
| `remote-deploy: tracked files were edited on the server` | Someone changed a file under `deploy/` on the server. `git -C /var/www/smm diff` shows it; put the change in the repo, then `git -C /var/www/smm checkout -- .` and push. `deploy/.env` is not tracked and never the cause. |
| `remote-deploy: ... is not on origin/main` | CI sent a commit that is not on `main` (a rerun of an old branch build). Push to `main`. |
| `deploy: database backup failed; nothing was changed` | Disk full (`df -h /`) or Postgres not answering (`docker logs postgres`). Free space; old app images go with `docker image prune -f`. |
| `deploy: no previous build recorded` | `rollback` before a second deploy happened. Deploy a tag by hand: `sh deploy/scripts/deploy.sh <tier> sha-<7 chars>`. |
| `otp/request` returns 429 | Rate limit per client address (5 codes per 15 min). Wait 15 minutes. |

## 8. Updating later

Nothing to do on the server: every push to `main` builds the image and deploys it here (see README, "How a push
deploys"), and CI fails the run when `https://<DOMAIN>/api/` does not answer 200 afterwards. By hand, in
`/var/www/smm`: `sh deploy/scripts/deploy.sh <tier> rollback` returns to the previous build;
`sh deploy/scripts/deploy.sh <tier>` applies a `deploy/.env` change. Run section 5 again after a change you made.
A move to a bigger server: bootstrap on the new one, then restore the latest `backups/pre-deploy-*.sql.gz` there
before the first deploy, and copy `deploy/.env` instead of letting bootstrap generate new secrets (the signing key and
`APP_CREDENTIALS_SECRET` must stay the same).
