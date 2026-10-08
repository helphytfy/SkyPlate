const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "skyplate.sqlite");

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 24) {
  console.error("ERROR: Set ADMIN_TOKEN to a long random secret (at least 24 characters).");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  reward_json TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses > 0),
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES promo_codes(id),
  player_id TEXT NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code_id, player_id)
);
`);

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}
function makeCode() {
  return "SKY-" + crypto.randomBytes(4).toString("hex").toUpperCase() + "-" +
    crypto.randomBytes(2).toString("hex").toUpperCase();
}
function validPlayerId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
}
function adminOnly(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "Неверный админ-токен." });
  }
  next();
}

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false,
  message: { ok: false, error: "Слишком много попыток. Подожди минуту и попробуй снова." }
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SkyPlate Promo Server" }));

app.post("/api/redeem", redeemLimiter, (req, res) => {
  const code = normalizeCode(req.body?.code);
  const playerId = req.body?.playerId;
  if (!code || code.length > 48 || !validPlayerId(playerId)) {
    return res.status(400).json({ ok: false, error: "Введи промокод ещё раз." });
  }

  const redeemTransaction = db.transaction(() => {
    const promo = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(code);
    if (!promo || !promo.active) return { status: 404, body: { ok: false, error: "Промокод не найден или отключён." } };
    if (promo.expires_at && Date.parse(promo.expires_at) <= Date.now()) {
      return { status: 410, body: { ok: false, error: "Срок действия промокода истёк." } };
    }
    const already = db.prepare("SELECT 1 FROM redemptions WHERE code_id = ? AND player_id = ?").get(promo.id, playerId);
    if (already) return { status: 409, body: { ok: false, error: "Ты уже активировал этот промокод." } };
    const count = db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ?").get(promo.id).n;
    if (count >= promo.max_uses) return { status: 410, body: { ok: false, error: "Все активации этого промокода уже использованы." } };

    db.prepare("INSERT INTO redemptions(code_id, player_id) VALUES (?, ?)").run(promo.id, playerId);
    return { status: 200, body: { ok: true, code, reward: JSON.parse(promo.reward_json) } };
  });

  try {
    const result = redeemTransaction();
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("Redeem error:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера. Попробуй позже." });
  }
});

app.use("/api/admin", adminLimiter, adminOnly);

app.get("/api/admin/codes", (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.code, p.reward_json, p.max_uses, p.expires_at, p.active, p.created_at,
      (SELECT COUNT(*) FROM redemptions r WHERE r.code_id = p.id) AS used
    FROM promo_codes p ORDER BY p.id DESC
  `).all().map(row => ({
    ...row, reward: JSON.parse(row.reward_json), reward_json: undefined
  }));
  res.json({ ok: true, codes: rows });
});

app.post("/api/admin/codes", (req, res) => {
  let code = normalizeCode(req.body?.code);
  if (!code) code = makeCode();
  if (!/^[A-Z0-9-]{4,48}$/.test(code)) return res.status(400).json({ ok: false, error: "Код: только латинские буквы, цифры и дефис (4–48 символов)." });

  const rewardInput = req.body?.reward || {};
  const text = String(rewardInput.text || "").trim().toUpperCase();
  const region = String(rewardInput.region || "").trim();
  const rarity = String(rewardInput.rarity || "MYTHIC").trim().toUpperCase();
  const label = String(rewardInput.label || "Промо-награда").trim().slice(0, 100);
  const series = String(rewardInput.series || "SKYPLATE PROMO").trim().slice(0, 60);
  const edition = String(rewardInput.edition || "LIMITED").trim().slice(0, 60);
  const plateType = String(rewardInput.plateType || "Эксклюзивный").trim().slice(0, 60);
  const price = String(rewardInput.price || "1000000");
  const maxUses = Number(req.body?.maxUses || 1);
  const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;

  if (!/^[А-ЯЁA-Z0-9]{1,10}$/.test(text) || !/^[0-9]{1,4}$/.test(region)) {
    return res.status(400).json({ ok: false, error: "Для награды укажи номер (например Х777ХХ) и регион (например 777)." });
  }
  if (!/^\d{1,40}$/.test(price)) return res.status(400).json({ ok: false, error: "Цена должна быть целым неотрицательным числом." });
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000) return res.status(400).json({ ok: false, error: "Лимит активаций должен быть от 1 до 1 000 000." });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return res.status(400).json({ ok: false, error: "Некорректная дата окончания." });

  const reward = {
    text, region, rarity, price, flag: "🇷🇺", countryCode: "RUS", country: "Россия",
    plateType, series, edition, id: "SP-PROMO-" + code.replace(/[^A-Z0-9-]/g, ""),
    label
  };
  try {
    const result = db.prepare("INSERT INTO promo_codes(code, reward_json, max_uses, expires_at) VALUES (?, ?, ?, ?)")
      .run(code, JSON.stringify(reward), maxUses, expiresAt);
    res.status(201).json({ ok: true, id: result.lastInsertRowid, code, reward, maxUses, expiresAt });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ ok: false, error: "Такой промокод уже существует." });
    console.error("Create code error:", err);
    res.status(500).json({ ok: false, error: "Не удалось создать промокод." });
  }
});

app.post("/api/admin/codes/:id/toggle", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Неверный ID." });
  const promo = db.prepare("SELECT id, active FROM promo_codes WHERE id = ?").get(id);
  if (!promo) return res.status(404).json({ ok: false, error: "Промокод не найден." });
  db.prepare("UPDATE promo_codes SET active = ? WHERE id = ?").run(promo.active ? 0 : 1, id);
  res.json({ ok: true, active: promo.active ? 0 : 1 });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SkyPlate Promo Server listening on port ${PORT}`);
});
