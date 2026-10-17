# FloodGuard

FloodGuard is a mobile-friendly flood map built with Next.js, React, TypeScript, Leaflet, and Tailwind CSS. It combines nearby community photo reports with Open-Meteo river, rainfall, and sea-level forecasts, and optionally uses Gemma through the Gemini API to estimate local flood risk.

Estimates and community reports are not official emergency warnings. Follow guidance from local emergency services.

## Features

- Location-aware map with nearby approved reports and a highlighted risk area.
- Streets, terrain, and satellite tiles with MapTiler; OpenStreetMap tiles when no MapTiler key is supplied.
- Photo reports positioned using photo GPS metadata or the submitter's device location, with an optional note.
- Automatic photo and note moderation. Rejected images are not stored; pending reports remain hidden until re-screened.
- Environmental estimates with a rules fallback when AI is unavailable, plus a photos-only demo mode.
- Installable PWA with an offline page fallback and optional Web Push alerts for the last shared location and up to five saved places.
- Private Azure Blob Storage for photos, with optional Azure PostgreSQL storage for report records and alerts.

## Local setup

Use Node.js 24 LTS and npm (the Docker image also uses Node 24). Install the Azure CLI if you will use Azure resources locally.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. `npm ci` generates the Prisma client through `postinstall`. Environment values are read from `.env.local`; restart the dev server after changing them.

The example contains sample Azure resource addresses. Replace them with your resources. For a UI-only run, clear `AZURE_STORAGE_ACCOUNT_URL` and `PGHOST`. The map can load without keys, but reporting and report lookup require Blob Storage, and threat estimates also need the report lookup to succeed. Alerts require PostgreSQL and VAPID keys. Without a Gemini key, newly submitted reports remain pending and hidden; environmental estimates can still use the rules fallback once storage is configured.

For testing on another device, use `npm run dev:https` and a certificate trusted by that device. Geolocation, service workers, and push require a secure context; localhost is treated as secure for local development. The development HTTPS certificate is not automatically trusted on other devices.

## Configuration

See [.env.example](.env.example) for a copyable template. Never commit `.env.local` or private keys.

| Variable | Purpose / default |
| --- | --- |
| `NEXT_PUBLIC_MAPTILER_KEY` | Optional public map tile key. Restrict it to your domains in MapTiler. |
| `AZURE_STORAGE_ACCOUNT_URL` | Blob account URL, e.g. `https://<account>.blob.core.windows.net`. Required for photo uploads and report lookup. |
| `AZURE_STORAGE_CONTAINER` | Existing private container; defaults to `flood-reports`. |
| `GEMINI_API_KEY` | Server-only Gemini API key for moderation and AI risk estimates. |
| `GEMMA_MODEL` | Main model; defaults to `gemma-4-26b-a4b-it`. Your account must have access to the configured model. |
| `GEMMA_FALLBACK_MODEL` | Model tried after transient main-model failures; defaults to `gemma-4-31b-it`. |
| `FLOODGUARD_PHOTOS_ONLY` | Set exactly `1` for demo mode: skip environmental forecasts and allow approved photos of any age. Otherwise reports expire from the map after 48 hours. |
| `PGHOST` | Azure PostgreSQL hostname. Leave empty to use blob metadata without database-backed alerts. |
| `PGDATABASE` | Database name; defaults to `floodguard`. |
| `PGUSER` | Entra database role matching your user, group, or managed identity. Required when using PostgreSQL. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Public Web Push application key, paired with the private key below. |
| `VAPID_PRIVATE_KEY` | Server-only Web Push private key. |
| `VAPID_SUBJECT` | Push service contact URL, usually `mailto:you@example.com`; defaults to `mailto:alerts@floodguard.app`. Set a real contact for your deployment. |
| `ALERT_CHECK_INTERVAL_MINUTES` | In-process schedule; defaults to `10`. Set `0` when using an external scheduler. |
| `ALERT_CRON_SECRET` | Bearer secret required by `POST /api/alerts/run`. |
| `AZURE_CLIENT_ID` | User-assigned managed identity client ID for Azure-hosted authentication, when needed. |

`NEXT_PUBLIC_*` values are included in the browser bundle at build time. Set them before `npm run build` or pass the Docker build arguments; changing only runtime environment values does not update browser configuration. Configure the same VAPID public key on the server and in the browser build.

### Azure authentication and storage

The app uses `DefaultAzureCredential`, with Entra ID authentication rather than storage account keys or a fixed database password.

1. Create a Blob Storage account and a private container.
2. Give your local identity the **Storage Blob Data Contributor** role on the account or container.
3. Run `az login` locally, then configure the storage URL and container.
4. In Azure, assign a managed identity to the app and grant it the same storage access. For a user-assigned identity, set `AZURE_CLIENT_ID`.

The app does not provision resources or create the container. Photos remain in private `pending/<date>/<uuid>.<extension>` blobs; moderation metadata controls public visibility. Approved photos are served through the app's photo route.

### Optional PostgreSQL

Use Azure Database for PostgreSQL with Entra authentication enabled. Create the database and an Entra role for the identity that runs the app; grant that role access to the application tables. The identity running migrations also needs permission to create and alter the schema. Configure network/firewall access, `PGHOST`, `PGDATABASE`, and `PGUSER`.

```powershell
az login
npm run db:migrate
```

The migration wrapper obtains an Entra token and builds a temporary `DATABASE_URL` for Prisma. The application uses a PostgreSQL connection pool with fresh tokens for new connections and certificate-verified TLS. A manually configured `DATABASE_URL` alone does not configure the application; it uses the `PG*` variables.

Apply migrations before serving traffic. When an empty reports table is first used, existing blob metadata is imported automatically. This import runs only when the table is empty; it is not a continuous synchronization or recovery tool. Photo storage and database writes are separate operations, so back up both and reconcile them after partial failures.

### Push alerts

Generate a key pair and put it in `.env.local`:

```powershell
npx web-push generate-vapid-keys
```

Alerts require PostgreSQL, both VAPID keys, browser support, and notification permission. On iPhone/iPad, users may need to install the app on their home screen first. Supported destinations are browser push services hosted by Google, Mozilla, Apple, and Microsoft; custom push services are rejected.

With alerts enabled, the app can save the last shared location while open and check it while closed; it does not track movement in the background. Last positions older than 14 days are ignored. Saved places remain active until removed. Risk alerts respect the selected threshold and can repeat after 12 hours; newly approved reports within 5 km can trigger notifications during their first six hours.

For one always-running server, the built-in timer checks every ten minutes by default. For multiple instances or hosts that suspend idle processes, set `ALERT_CHECK_INTERVAL_MINUTES=0` and schedule one caller:

```powershell
curl.exe -X POST https://<your-host>/api/alerts/run -H "Authorization: Bearer <ALERT_CRON_SECRET>"
```

Prevent overlapping scheduler runs. The in-process overlap guard and caches are per instance; threat notifications are not globally deduplicated. Push delivery is best effort, not a guaranteed emergency channel.

## Commands

| Command | Action |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run dev:https` | Start development with experimental HTTPS. |
| `npm run build` | Generate Prisma client and create the production build. |
| `npm start` | Serve the production build on port 3000. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run isolated regression tests using Node's test runner. |
| `npx tsc --noEmit` | Check TypeScript types (run a build first to generate Next route types on a clean checkout). |
| `npm run db:generate` | Generate the Prisma client without connecting to a database. |
| `npm run db:migrate` | Apply committed migrations with an Entra token. |
| `npm run db:migrate:dev -- --name <change>` | Create/apply a development migration; use a development database. |
| `npm run db:studio` | Open Prisma Studio against the configured database. |
| `npm run icons` | Regenerate PNG app icons from `public/icon.svg`. |

The build fetches the Geist fonts through `next/font/google`, so its first run needs network access to Google's font service. Icon generation uses the `sharp` package installed with Next.js.

## Project layout

```text
app/                    App Router page, metadata, manifest, API routes
components/             Map, report form, sidebar, alert controls, UI primitives
lib/                    Forecasts, AI/moderation, storage, alerts, client hooks
prisma/                 PostgreSQL schema and committed migrations
public/                 App icons and service worker
scripts/                Azure-authenticated Prisma wrapper and icon generation
.github/workflows/      Container build and Azure deployment workflow
```

## API overview

| Route | Purpose |
| --- | --- |
| `GET /api/threat?lat=&lng=` | Cached risk assessment for a location. |
| `GET /api/reports?lat=&lng=` | Up to 20 approved reports within 25 km. |
| `POST /api/reports` | Multipart upload: `photo`, `locationSource` (`photo` or `device`), device `latitude`/`longitude` when needed, optional `accuracy` and `note`. JPEG, PNG, or WebP up to 8 MiB; note up to 500 characters. |
| `GET /api/reports/photo/<day>/<file>` | Approved report photo; pending/rejected photos stay private. |
| `PUT /api/alerts/subscription` | Register a browser subscription or update its threshold using its existing auth secret. |
| `DELETE /api/alerts/subscription` | Delete the subscription and its stored places. |
| `GET/POST/DELETE /api/alerts/places` | List, save, or remove places. |
| `PUT/DELETE /api/alerts/location` | Set or clear the last shared position. |
| `POST /api/alerts/run` | Run a scheduled check with the cron bearer secret. |

Protected subscription operations use `X-Push-Endpoint` and `X-Push-Auth` headers. Treat these credentials as secrets: they authorize access to saved locations. There are no user accounts or administrative moderation screens.

## Production and deployment

```powershell
npm run lint
npm test
npm run build
npm start
```

The app requires a Node server; it cannot be deployed as a static export. `next.config.ts` enables standalone output, and the provided Dockerfile runs it as the non-root `node` user:

```powershell
docker build --build-arg NEXT_PUBLIC_MAPTILER_KEY=<public-key> --build-arg NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public-key> -t floodguard .
docker run --rm -p 3000:3000 --env-file .env.local floodguard
```

If a Windows build reports a Turbopack CSS worker error such as `node process exited before we could connect to it`, `npm run build -- --webpack` can help isolate bundler failures from application compilation. This is a diagnostic command: the current Tailwind configuration uses a Turbopack-specific loader, so the Webpack output leaves Tailwind directives unprocessed and is not ready for deployment. Use the normal build for the styled application. A `fonts.googleapis.com` lookup/download error instead requires build-time network access for `next/font/google` (or a separately configured local font setup).

Configure runtime secrets and managed identity on the hosting platform. The container does not include the Azure CLI or your local `az login` session; an Azure managed identity is the intended deployment authentication method. Run migrations separately from a checkout or deployment job with database access; the production image does not include the Prisma migration CLI.

[The deployment workflow](.github/workflows/deploy.yml) builds and pushes an image to Azure Container Registry and updates an existing Azure Container App on pushes to `master` or manual dispatch. Update its registry, resource group, image, and app names for your deployment. Configure repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `NEXT_PUBLIC_MAPTILER_KEY`, and `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, plus an OIDC federated credential and appropriate registry/app permissions for the deployment identity. The app's runtime identity and secrets must be configured separately. The workflow does not provision infrastructure, run tests, or apply migrations.

## Data handling and limitations

- Location queries reach the app server; forecast and AI services receive location-related inputs. Submitted images and notes are sent to the Gemini API for moderation and may be used in risk assessment. Approved report photos and their coordinates are publicly accessible through the app.
- Photos can retain EXIF location/capture metadata. Do not submit sensitive images. Subscription secrets, saved places, and last shared locations are stored in PostgreSQL; disabling alerts deletes that subscription and its places. Report blobs/records have no automatic deletion policy.
- Normal mode uses recent reports, while photos-only mode deliberately includes old demo reports and should not be treated as a live warning system.
- Missing report data or completely unavailable environmental data produces an assessment error instead of a reassuring all-clear. Partial data and model mistakes can still miss flooding.
- The offline fallback caches navigation pages, not a complete offline map or live forecasts. Reconnect for current information.
- Rate limits are held in memory, capped per instance, and keyed from `X-Forwarded-For`. Use a trusted proxy that replaces this header and shared gateway limits before scaling or exposing the service publicly.
- Risk caches and pending-report re-screening run in each server process. Pending reports are re-screened in small batches during report-list refreshes; this is not a durable moderation queue.
- Regression tests isolate external services with mocks; they do not validate live Azure permissions, database row locks, model availability, or device push delivery. Validate these in your deployment environment.
- Check the terms, attribution, and quotas for Open-Meteo, map tile providers, and the Gemini API before production use; the code notes Open-Meteo's keyless non-commercial service.

## License

[MIT](LICENSE).
