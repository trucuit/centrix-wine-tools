"use strict";

// Google Sign-In config for the CentriX App User ACCOUNT login (the "Đăng nhập bằng Google" button).
// The Client ID is PUBLIC (safe to ship). The Client SECRET is read from env on the SERVER ONLY and
// defaults to empty so it is never bundled into the App User asar — set CENTRIX_GOOGLE_CLIENT_SECRET on
// the host that runs the backend (so the backend can mint account tokens without the App Server).
const GOOGLE_CLIENT_ID = String(
  process.env.CENTRIX_GOOGLE_CLIENT_ID ||
  "424062159436-1r8kbv5474cvbh4hinng7jeqb86fm0r3.apps.googleusercontent.com"
);
const GOOGLE_CLIENT_SECRET = String(process.env.CENTRIX_GOOGLE_CLIENT_SECRET || "");
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = "openid email profile";

module.exports = {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_SCOPE
};
