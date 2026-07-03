# Spotify Compilation Playlist

Nightly job that reads tracks from source Spotify playlists, stores the unique track URI list in MongoDB, and replaces one destination playlist with that compiled list.

## Endpoints

- `GET /login` starts Spotify authorization.
- `GET /callback` receives Spotify's authorization code. Add this exact URL to the Spotify app redirect URI allowlist.
- `POST /cron/update` runs the whole sync. Send `Authorization: Bearer $CRON_SECRET`.
- `GET /auth/status` returns non-secret authorization status.
- `GET /healthz` returns a basic health check.

Legacy endpoints still exist, but now require the cron secret:

- `GET /refresh_token`
- `GET /pull_songs`
- `GET /update_playlist`

## Required Environment Variables

Set these in App Engine:

- `MONGOURI`: MongoDB connection string.
- `SPOTIFY_CLIENT_ID`: Spotify Developer Dashboard client ID.
- `SPOTIFY_CLIENT_SECRET`: Spotify Developer Dashboard client secret.
- `SPOTIFY_REDIRECT_URI`: Full callback URL, for example `https://YOUR_PROJECT.REGION_ID.r.appspot.com/callback`.
- `PLAYLISTID`: destination Spotify playlist ID.
- `CRON_SECRET`: long random value shared with GitHub Actions.

Optional:

- `SOURCE_PLAYLIST_IDS`: comma-separated source playlist IDs. If omitted, the app reads MongoDB collection `spotifycompDB.playlists` document `{ locator: "playlists" }` and expects a `playlists` array of strings or objects with `id`.
- `MONGO_DB_NAME`: defaults to `spotifycompDB`.
- `MONGO_AUTH_COLLECTION`: defaults to `auth`.
- `MONGO_PLAYLISTS_COLLECTION`: defaults to `playlists`.
- `MONGO_TRACKS_COLLECTION`: defaults to `uris`.

## Safe App Engine Deployment

Do not commit secrets to `app.yaml` in this public repo.

Recommended deployment pattern:

1. Create a local untracked deployment file, for example `app.deploy.yaml`, with the same runtime settings plus `env_variables`.
2. Add `app.deploy.yaml` to `.git/info/exclude` or `.gitignore` before adding secrets.
3. Deploy from your machine with `gcloud app deploy app.deploy.yaml`.

Example local-only `app.deploy.yaml`:

```yaml
runtime: nodejs24
instance_class: F1
env: standard

env_variables:
  NODE_ENV: production
  MONGOURI: "mongodb+srv://..."
  SPOTIFY_CLIENT_ID: "..."
  SPOTIFY_CLIENT_SECRET: "..."
  SPOTIFY_REDIRECT_URI: "https://YOUR_PROJECT.REGION_ID.r.appspot.com/callback"
  PLAYLISTID: "..."
  CRON_SECRET: "..."
  SOURCE_PLAYLIST_IDS: "playlist_id_1,playlist_id_2"
```

## Spotify Developer Dashboard

1. Create or update a Spotify app.
2. Add the exact redirect URI from `SPOTIFY_REDIRECT_URI`. Spotify requires exact matching and HTTPS for non-loopback redirect URIs.
3. Use Authorization Code flow. This app stores only server-side tokens in MongoDB.
4. Authorize once by visiting `/login` after deployment.

Spotify refresh tokens for Developer Dashboard apps expire after 6 months. The app refreshes hourly access tokens automatically, but after the refresh token expires you must visit `/login` again. `/auth/status` reports the approximate refresh token expiration when known.

## GitHub Actions

Set repository secrets:

- `APP_CRON_URL`: base URL of the deployed App Engine service, for example `https://YOUR_PROJECT.REGION_ID.r.appspot.com`.
- `CRON_SECRET`: same value as App Engine `CRON_SECRET`.

The workflow calls:

```sh
curl --fail --show-error --silent \
  --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${APP_CRON_URL}/cron/update"
```

## Local Development

Create `.env` locally:

```sh
MONGOURI="mongodb://127.0.0.1:27017"
SPOTIFY_CLIENT_ID="..."
SPOTIFY_CLIENT_SECRET="..."
SPOTIFY_REDIRECT_URI="http://127.0.0.1:8080/callback"
PLAYLISTID="..."
CRON_SECRET="..."
SOURCE_PLAYLIST_IDS="playlist_id_1,playlist_id_2"
```

For local Spotify auth, add `http://127.0.0.1:8080/callback` to the Spotify redirect URI allowlist. Spotify no longer accepts `localhost` for newly validated redirect URIs.
