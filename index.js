require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 8080;
const DB_NAME = process.env.MONGO_DB_NAME || 'spotifycompDB';
const AUTH_COLLECTION = process.env.MONGO_AUTH_COLLECTION || 'auth';
const PLAYLISTS_COLLECTION = process.env.MONGO_PLAYLISTS_COLLECTION || 'playlists';
const TRACKS_COLLECTION = process.env.MONGO_TRACKS_COLLECTION || 'uris';
const STATE_COOKIE = 'spotify_auth_state';
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
];

const requiredEnv = [
  'MONGOURI',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI',
  'PLAYLISTID',
  'CRON_SECRET',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`Missing required environment variable: ${key}`);
  }
}

const app = express();
const mongoClient = new MongoClient(process.env.MONGOURI || 'mongodb://127.0.0.1:27017');

app.use(express.json());
app.use(cookieParser());
app.use(express.static(`${__dirname}/public`));

function db() {
  return mongoClient.db(DB_NAME);
}

function authCollection() {
  return db().collection(AUTH_COLLECTION);
}

function playlistsCollection() {
  return db().collection(PLAYLISTS_COLLECTION);
}

function tracksCollection() {
  return db().collection(TRACKS_COLLECTION);
}

function spotifyBasicAuthHeader() {
  const credentials = `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

function ensureConfig(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    const error = new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
    error.status = 500;
    throw error;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cronAuthorized(req) {
  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const headerSecret = req.get('x-cron-secret');
  const querySecret = req.query.secret;

  return [bearer, headerSecret, querySecret].some((candidate) => safeEqual(candidate, process.env.CRON_SECRET));
}

function requireCronSecret(req, res, next) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'Missing required environment variable(s): CRON_SECRET' });
  }

  if (!cronAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  return next();
}

function normalizeTokenResponse(tokenResponse, existingToken = {}) {
  const now = Date.now();
  const refreshToken = tokenResponse.refresh_token || existingToken.refresh_token;
  const refreshTokenIssuedAt = tokenResponse.refresh_token
    ? now
    : existingToken.refresh_token_issued_at || existingToken.authorized_at;

  return {
    ...existingToken,
    ...tokenResponse,
    refresh_token: refreshToken,
    refresh_token_issued_at: refreshTokenIssuedAt,
    refresh_token_expires_at: refreshTokenIssuedAt
      ? refreshTokenIssuedAt + REFRESH_TOKEN_LIFETIME_MS
      : existingToken.refresh_token_expires_at,
    expires_at: now + tokenResponse.expires_in * 1000,
    updated_at: new Date(),
    token_type: tokenResponse.token_type || 'Bearer',
    provider: 'spotify',
    needs_reauthorization: false,
  };
}

async function saveToken(tokenData) {
  await authCollection().updateOne(
    { token_type: 'Bearer' },
    { $set: tokenData, $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  );
}

async function getStoredToken() {
  return authCollection().findOne({ token_type: 'Bearer' });
}

async function exchangeAuthorizationCode(code) {
  ensureConfig(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI']);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: spotifyBasicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || 'Spotify authorization failed');
    error.status = response.status;
    throw error;
  }

  const tokenData = normalizeTokenResponse({
    ...payload,
    authorized_at: Date.now(),
  });
  await saveToken(tokenData);

  return tokenData;
}

async function refreshStoredToken(existingToken) {
  ensureConfig(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);

  if (!existingToken || !existingToken.refresh_token) {
    const error = new Error('Spotify is not authorized. Visit /login to authorize this app.');
    error.status = 401;
    throw error;
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: spotifyBasicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existingToken.refresh_token,
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    if (payload.error === 'invalid_grant') {
      await authCollection().updateOne(
        { token_type: 'Bearer' },
        { $set: { needs_reauthorization: true, reauthorization_required_at: new Date() } },
      );
    }

    const error = new Error(payload.error_description || payload.error || 'Spotify token refresh failed');
    error.status = response.status;
    error.spotifyError = payload.error;
    throw error;
  }

  const tokenData = normalizeTokenResponse(payload, existingToken);
  await saveToken(tokenData);

  return tokenData;
}

async function getValidSpotifyToken({ forceRefresh = false } = {}) {
  const token = await getStoredToken();

  if (
    !forceRefresh
    && token
    && token.access_token
    && token.expires_at
    && token.expires_at - TOKEN_EXPIRY_SKEW_MS > Date.now()
  ) {
    return token;
  }

  return refreshStoredToken(token);
}

async function spotifyRequest(pathOrUrl, options = {}) {
  let token = await getValidSpotifyToken();
  let response = await sendSpotifyRequest(pathOrUrl, options, token.access_token);

  if (response.status === 401) {
    token = await getValidSpotifyToken({ forceRefresh: true });
    response = await sendSpotifyRequest(pathOrUrl, options, token.access_token);
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 1);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    response = await sendSpotifyRequest(pathOrUrl, options, token.access_token);
  }

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || 'Spotify API request failed');
    error.status = response.status;
    error.spotifyPayload = payload;
    throw error;
  }

  return payload;
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

async function sendSpotifyRequest(pathOrUrl, options, accessToken) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://api.spotify.com/v1${pathOrUrl}`;

  return fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function getSourcePlaylistIds() {
  if (process.env.SOURCE_PLAYLIST_IDS) {
    return process.env.SOURCE_PLAYLIST_IDS
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  const playlistDoc = await playlistsCollection().findOne({ locator: 'playlists' });
  const playlists = playlistDoc?.playlists || [];

  return playlists
    .map((playlist) => (typeof playlist === 'string' ? playlist : playlist.id))
    .filter(Boolean);
}

async function fetchPlaylistTrackUris(playlistId) {
  const trackUris = [];
  let nextUrl = `/playlists/${playlistId}/items?limit=50&fields=items(track(uri,type)),next`;

  while (nextUrl) {
    const page = await spotifyRequest(nextUrl);
    const pageUris = (page.items || [])
      .map((item) => item.track)
      .filter((track) => track?.type === 'track' && track.uri && !track.uri.startsWith('spotify:local:'))
      .map((track) => track.uri);

    trackUris.push(...pageUris);
    nextUrl = page.next;
  }

  return trackUris;
}

async function collectTrackUris() {
  const playlistIds = await getSourcePlaylistIds();

  if (playlistIds.length === 0) {
    const error = new Error('No source playlists configured. Set SOURCE_PLAYLIST_IDS or add playlists to MongoDB.');
    error.status = 400;
    throw error;
  }

  const seen = new Set();

  for (const playlistId of playlistIds) {
    const uris = await fetchPlaylistTrackUris(playlistId);

    for (const uri of uris) {
      seen.add(uri);
    }
  }

  return {
    playlistIds,
    trackUris: [...seen],
  };
}

async function persistTrackUris(trackUris) {
  await tracksCollection().updateOne(
    { tracking: 'trackList' },
    {
      $set: {
        arr: trackUris,
        count: trackUris.length,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );
}

function chunk(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

async function replaceDestinationPlaylist(trackUris) {
  ensureConfig(['PLAYLISTID']);

  const [firstChunk = [], ...remainingChunks] = chunk(trackUris, 100);

  await spotifyRequest(`/playlists/${process.env.PLAYLISTID}/items`, {
    method: 'PUT',
    body: { uris: firstChunk },
  });

  for (const uris of remainingChunks) {
    await spotifyRequest(`/playlists/${process.env.PLAYLISTID}/items`, {
      method: 'POST',
      body: { uris },
    });
  }
}

async function updateCompilationPlaylist() {
  const { playlistIds, trackUris } = await collectTrackUris();
  await persistTrackUris(trackUris);
  await replaceDestinationPlaylist(trackUris);

  return {
    sourcePlaylists: playlistIds.length,
    tracks: trackUris.length,
    destinationPlaylistId: process.env.PLAYLISTID,
  };
}

function handleRoute(fn) {
  return async (req, res) => {
    try {
      await mongoClient.connect();
      await fn(req, res);
    } catch (error) {
      console.error(error);
      res.status(error.status || 500).json({
        error: error.message || 'Unexpected error',
        reauthorize: error.spotifyError === 'invalid_grant' ? '/login' : undefined,
      });
    }
  };
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/login', handleRoute(async (req, res) => {
  ensureConfig(['SPOTIFY_CLIENT_ID', 'SPOTIFY_REDIRECT_URI']);

  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES.join(' '),
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
}));

app.get('/callback', handleRoute(async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const storedState = req.cookies?.[STATE_COOKIE];

  if (!code) {
    return res.status(400).send('Missing Spotify authorization code.');
  }

  if (!state || !storedState || state !== storedState) {
    return res.status(400).send('Spotify authorization state mismatch.');
  }

  res.clearCookie(STATE_COOKIE);
  await exchangeAuthorizationCode(code);

  return res.redirect('/?authorized=1');
}));

app.get('/auth/status', handleRoute(async (req, res) => {
  const token = await getStoredToken();

  res.json({
    authorized: Boolean(token?.refresh_token),
    needsReauthorization: Boolean(token?.needs_reauthorization),
    accessTokenExpiresAt: token?.expires_at ? new Date(token.expires_at).toISOString() : null,
    refreshTokenExpiresAt: token?.refresh_token_expires_at
      ? new Date(token.refresh_token_expires_at).toISOString()
      : null,
  });
}));

app.post('/cron/update', requireCronSecret, handleRoute(async (req, res) => {
  const result = await updateCompilationPlaylist();
  res.json({ ok: true, ...result });
}));

app.get('/cron/update', requireCronSecret, handleRoute(async (req, res) => {
  const result = await updateCompilationPlaylist();
  res.json({ ok: true, ...result });
}));

app.get('/refresh_token', requireCronSecret, handleRoute(async (req, res) => {
  const token = await getValidSpotifyToken({ forceRefresh: true });

  res.json({
    ok: true,
    accessTokenExpiresAt: new Date(token.expires_at).toISOString(),
    refreshTokenExpiresAt: token.refresh_token_expires_at
      ? new Date(token.refresh_token_expires_at).toISOString()
      : null,
  });
}));

app.get('/pull_songs', requireCronSecret, handleRoute(async (req, res) => {
  const { playlistIds, trackUris } = await collectTrackUris();
  await persistTrackUris(trackUris);

  res.json({ ok: true, sourcePlaylists: playlistIds.length, tracks: trackUris.length });
}));

app.get('/update_playlist', requireCronSecret, handleRoute(async (req, res) => {
  const tracksDoc = await tracksCollection().findOne({ tracking: 'trackList' });
  const trackUris = (tracksDoc?.arr || []).filter((uri) => !uri.startsWith('spotify:local:'));
  await replaceDestinationPlaylist(trackUris);

  res.json({ ok: true, tracks: trackUris.length, destinationPlaylistId: process.env.PLAYLISTID });
}));

app.listen(PORT, () => {
  console.log(`Listening at http://localhost:${PORT}`);
});
