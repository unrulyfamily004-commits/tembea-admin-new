const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const required = ["DATABASE_URL", "JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) console.error(`Missing environment variable: ${key}`);
}
if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  // Keep the function alive so the browser can receive a useful JSON error.
}

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
}) : null;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || "tembea-media";

let dbReady;
async function initDb() {
  if (!pool) throw new Error("DATABASE_URL is missing in Vercel environment variables.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS listings (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('adventure','event')),
      title TEXT NOT NULL, location TEXT NOT NULL, date TEXT,
      price INTEGER NOT NULL DEFAULT 0, slots INTEGER NOT NULL DEFAULT 0,
      category TEXT DEFAULT '', description TEXT DEFAULT '', image TEXT DEFAULT '',
      published BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY, listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT DEFAULT '',
      people INTEGER NOT NULL DEFAULT 1, payment_reference TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', payment_status TEXT NOT NULL DEFAULT 'unverified',
      notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', email TEXT DEFAULT '',
      message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (email && password) {
    const existing = await pool.query("SELECT id FROM admins WHERE email=$1", [email]);
    if (!existing.rowCount) {
      await pool.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [email, await bcrypt.hash(password, 12)]);
    }
  }
}
dbReady = initDb();

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = value => String(value ?? "").trim();

function auth(req, res, next) {
  try {
    const token = req.cookies.admin_session;
    if (!token) return res.status(401).json({ error: "Please sign in again." });
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}
app.use("/api", asyncRoute(async (req, res, next) => {
  await dbReady;
  next();
}));

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT * FROM admins WHERE email=$1", [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "The email or password is incorrect." });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "8h" });
  res.cookie("admin_session", token, {
    httpOnly: true, secure: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000, path: "/"
  });
  res.json({ email: user.email });
}));
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("admin_session", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", auth, (req, res) => res.json({ email: req.admin.email }));

app.get("/api/admin/stats", auth, asyncRoute(async (req, res) => {
  const [listings, bookings, messages, revenue] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE published=TRUE)::int AS published FROM listings"),
    pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='pending')::int AS pending, COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed FROM bookings"),
    pool.query("SELECT COUNT(*)::int AS total FROM messages"),
    pool.query("SELECT COALESCE(SUM(b.people*l.price),0)::numeric AS total FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.payment_status='verified' AND b.status='confirmed'")
  ]);
  res.json({
    listings: listings.rows[0],
    bookings: bookings.rows[0],
    messages: messages.rows[0],
    verifiedRevenue: Number(revenue.rows[0].total || 0)
  });
}));

app.get("/api/admin/listings", auth, asyncRoute(async (req, res) => {
  const r = await pool.query("SELECT * FROM listings ORDER BY id DESC");
  res.json(r.rows);
}));
app.post("/api/admin/listings", auth, asyncRoute(async (req, res) => {
  const v = req.body || {};
  const type = clean(v.type), title = clean(v.title), location = clean(v.location);
  const price = Number(v.price || 0), slots = Number(v.slots || 0);
  if (!["adventure", "event"].includes(type) || title.length < 3 || location.length < 2 ||
      !Number.isFinite(price) || price < 0 || !Number.isInteger(slots) || slots < 0) {
    return res.status(400).json({ error: "Please fill in the title, location, type, price and spaces correctly." });
  }
  const r = await pool.query(
    "INSERT INTO listings(type,title,location,date,price,slots,category,description,image,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
    [type, title, location, clean(v.date) || null, Math.round(price), slots, clean(v.category).slice(0,80),
     clean(v.description).slice(0,4000), clean(v.image).slice(0,1000), v.published !== false]
  );
  res.status(201).json(r.rows[0]);
}));
app.put("/api/admin/listings/:id", auth, asyncRoute(async (req, res) => {
  const oldResult = await pool.query("SELECT * FROM listings WHERE id=$1", [Number(req.params.id)]);
  if (!oldResult.rowCount) return res.status(404).json({ error: "Adventure or event not found." });
  const v = { ...oldResult.rows[0], ...(req.body || {}) };
  if (!["adventure", "event"].includes(v.type) || clean(v.title).length < 3 || clean(v.location).length < 2 ||
      !Number.isFinite(Number(v.price)) || Number(v.price) < 0 || !Number.isInteger(Number(v.slots)) || Number(v.slots) < 0) {
    return res.status(400).json({ error: "Please check the listing details." });
  }
  await pool.query(
    "UPDATE listings SET type=$1,title=$2,location=$3,date=$4,price=$5,slots=$6,category=$7,description=$8,image=$9,published=$10 WHERE id=$11",
    [v.type, clean(v.title), clean(v.location), clean(v.date) || null, Number(v.price), Number(v.slots),
     clean(v.category), clean(v.description), clean(v.image), v.published === true || v.published === 1 || v.published === "true", Number(req.params.id)]
  );
  res.json({ ok: true });
}));
app.delete("/api/admin/listings/:id", auth, asyncRoute(async (req, res) => {
  const r = await pool.query("DELETE FROM listings WHERE id=$1 RETURNING id", [Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Listing not found." });
  res.json({ ok: true });
}));

app.get("/api/admin/bookings", auth, asyncRoute(async (req, res) => {
  const r = await pool.query("SELECT b.*,l.title AS listing_title,l.date AS listing_date,l.price AS listing_price FROM bookings b LEFT JOIN listings l ON l.id=b.listing_id ORDER BY b.id DESC");
  res.json(r.rows);
}));
app.patch("/api/admin/bookings/:id", auth, asyncRoute(async (req, res) => {
  const status = clean(req.body.status), payment = clean(req.body.payment_status);
  if (!["pending","confirmed","cancelled"].includes(status) || !["unverified","verified","rejected"].includes(payment)) {
    return res.status(400).json({ error: "Choose a valid booking and payment status." });
  }
  const r = await pool.query("UPDATE bookings SET status=$1,payment_status=$2 WHERE id=$3 RETURNING id", [status, payment, Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Booking not found." });
  res.json({ ok: true });
}));
app.get("/api/admin/messages", auth, asyncRoute(async (req, res) => {
  const r = await pool.query("SELECT * FROM messages ORDER BY id DESC");
  res.json(r.rows);
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
    cb(ok ? null : new Error("Only image or video files are allowed."), ok);
  }
});
app.post("/api/admin/upload", auth, upload.single("media"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a photo or video first." });
  if (!supabase) return res.status(503).json({ error: "Media storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel." });
  const ext = path.extname(req.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
  const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(name, req.file.buffer, { contentType: req.file.mimetype, cacheControl: "3600", upsert: false });
  if (error) return res.status(502).json({ error: "Upload failed. Check the Supabase tembea-media bucket." });
  const { data } = supabase.storage.from(bucket).getPublicUrl(name);
  res.status(201).json({ url: data.publicUrl, filename: name });
}));

app.use((err, req, res, next) => {
  console.error("Admin API error:", err.message || err);
  const msg = err.message === "File too large" ? "Media file must be 4 MB or smaller." :
    err.message === "Only image or video files are allowed." ? err.message :
    err.message && err.message.includes("DATABASE_URL") ? err.message :
    "Something went wrong. Check the Vercel environment variables and database connection.";
  res.status(err.message === "File too large" ? 413 : 500).json({ error: msg });
});

module.exports = app;
