# Operations Runbook

## Health and Readiness
- Liveness: `GET /api/health` should return `200` with `status: ok`.
- Readiness: `GET /api/ready` should return:
  - `200` with `status: ready` when dependencies are healthy.
  - `503` with `status: not-ready` when any check fails.

## Required Environment Variables
- `JWT_SECRET`
- `APP_ORIGIN`
- `BACKUP_SIGNING_KEY`

## Incident Response
1. Confirm impact and scope from logs (`admin-audit.log`, app logs).
2. If auth/session compromise is suspected:
   - Rotate `JWT_SECRET`.
   - Force logout by restarting services and invalidating old tokens.
3. If backup tampering is suspected:
   - Do not restore unsigned/unverified backups.
   - Validate signature metadata before any restore.
4. If storage abuse is suspected:
   - Temporarily disable uploads at reverse proxy or app layer.
   - Inspect upload directory and recent message attachments.
5. Document timeline, actions, and remediation items in incident notes.

## Secret Rotation Policy
- Rotate `JWT_SECRET` every 90 days or immediately after suspected compromise.
- Rotate `BACKUP_SIGNING_KEY` every 180 days.
- Store secrets in deployment secret manager, not in repository.
- Keep an internal rotation log with:
  - Secret name
  - Rotation timestamp
  - Operator
  - Rollout status

## Deployment Checklist
- `npm run lint` passes.
- `npm run build` passes.
- `/api/health` is `ok`.
- `/api/ready` is `ready`.
- Backup signature verification tested with one create+restore dry run.

## Railway Deployment Notes
- Config lives in `railway.json` (Nixpacks builder, `npm run build` for build, `npm run start:railway` for start, healthcheck `/api/health`).
- `start:railway` runs `prisma db push --accept-data-loss --skip-generate` (schema sync) then the seed, then boots the server. Schema changes are applied on every deploy.
- Required service variables: `DATABASE_URL` (MongoDB Atlas `mongodb+srv://`, replica set required), `JWT_SECRET`, `BACKUP_SIGNING_KEY`, `APP_ORIGIN` (public `https://` URL).
- Do not set `PORT`; Railway injects it and the server binds `0.0.0.0:$PORT`.
- Rotate secrets via Railway Variables (applied on next deploy) per the rotation policy above.
- Uploaded files are local-disk; mount a Railway volume and point `UPLOAD_DIR`/`BACKUP_DIR` at it if persistence across redeploys is needed.
- Run a single instance: Socket.IO presence and active-call state are in-memory.
