// Paste your keys here. Both are meant to live in client code:
// the TMDB key only reads public movie data, and Firebase is locked
// down by the rules in database.rules.json, not by hiding this config.

// TMDB → Settings → API → "API Key" (the short one).
export const TMDB_API_KEY = "e516490d4fa5f4dca11b71621dd54b81";

// Firebase console → Project settings → Your apps → Web app → SDK setup and configuration.
// Replace null with the object Firebase shows you, e.g.
// { apiKey: "...", authDomain: "...", databaseURL: "...", projectId: "...", appId: "..." }
export const FIREBASE_CONFIG = null;
