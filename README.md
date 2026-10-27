# TEMBEA NA UNRULY — New Admin Panel

A separate admin dashboard with a green/black/white design. It uses the same PostgreSQL tables and Supabase Storage bucket as the existing website.

## Files
- `public/index.html` — new admin dashboard UI
- `api/index.js` — protected server API (password verification, listings, bookings, messages, media uploads)
- `vercel.json` — sends `/api/*` requests to the API function
- `package.json` — server dependencies

## Required Vercel environment variables
Copy these from the existing Vercel project into the new project:
- `DATABASE_URL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `SUPABASE_STORAGE_BUCKET` (defaults to `tembea-media`)

Keep all secrets server-side. Never add them to `public/index.html`.

## Important notes
- This project creates the expected tables if they do not exist, but it is intended to reuse the existing database.
- The admin record is created only if the email does not already exist in the `admins` table. If that account already exists with a different password, update the admin password securely rather than exposing it in client code.
- Media uploads are limited to 4 MB per file on this first Vercel version.
- The admin panel is separate from the public site; it does not replace the public homepage.
