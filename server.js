import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// 1. ตั้งค่าพื้นฐาน
dotenv.config();
const app = express();
app.use(express.json({ limit: "10mb" })); // รองรับ JSON ขนาดใหญ่

// 2. ตั้งค่า CORS
app.use(cors({
    origin: true, // หรือระบุ ["http://localhost:3000"]
    credentials: true,
}));

// 3. เชื่อมต่อ Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
});

pool.connect().then(c => { console.log("✅ Database Connected!"); c.release(); })
    .catch(e => console.error("❌ DB Connection Failed:", e.message));

const JWT_SECRET = process.env.JWT_SECRET || "secret";
const PORT = Number(process.env.PORT || 4000);

// 4. ตั้งค่า Upload
const __filename = fileURLToPath(import.meta.url);
const UPLOAD_DIR = path.join(path.dirname(__filename), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

const upload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, UPLOAD_DIR),
        filename: (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
    })
});

// 5. Middleware
function authRequired(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "No Token" });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ message: "Invalid Token" }); }
}

function adminRequired(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ message: "Admin Only" });
    next();
}

// 6. Helper Functions
function generateSlug(title, existingSlug = "") {
    if (existingSlug) return existingSlug;
    if (!title) return `no-title-${Date.now()}`;
    return title.trim().replace(/\s+/g, "-").toLowerCase();
}

// ฟังก์ชันสร้าง SQL Update แบบ Dynamic (แก้เฉพาะค่าที่ส่งมา)
async function dynamicUpdate(table, id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    // วนลูป key ที่ส่งมาเพื่อสร้าง Query
    for (const [key, value] of Object.entries(updates)) {
        if (key === 'id') continue; // ข้าม ID

        if (key === 'subcategories') {
            fields.push(`${key}=$${idx++}::jsonb`);
            values.push(JSON.stringify(value));
        } else {
            fields.push(`${key}=$${idx++}`);
            values.push(value);
        }
    }

    if (fields.length === 0) return null; // ไม่มีการอัปเดต

    values.push(id);
    const query = `UPDATE ${table} SET ${fields.join(", ")} WHERE id=$${idx} RETURNING *`;

    try {
        const { rows } = await pool.query(query, values);
        return rows[0];
    } catch (e) {
        console.error(`Dynamic Update Error (${table}):`, e.message);
        throw e;
    }
}

// ==========================================
// 🚀 API ZONE
// ==========================================

// --- Login ---
app.post("/api/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        const { rows } = await pool.query("SELECT * FROM public.admin_users WHERE username=$1", [username]);
        if (!rows.length || rows[0].password_hash !== password) {
            return res.status(401).json({ message: "Login failed" });
        }
        const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: "7d" });
        res.json({ token, user: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Upload ---
app.post("/api/upload", authRequired, adminRequired, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file" });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// ---------------------------------------------------------
// 🟢 1. หมวดหมู่สินค้า (Product Categories)
// ---------------------------------------------------------
app.get("/api/product-categories", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM product_categories ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/product-categories", authRequired, adminRequired, async (req, res) => {
    try {
        const { title, sort_order, is_active, subcategories } = req.body;
        const slug = generateSlug(title, req.body.slug);

        const { rows } = await pool.query(
            `INSERT INTO product_categories (title, slug, sort_order, is_active, subcategories) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
            [title, slug, sort_order || 0, is_active ?? true, JSON.stringify(subcategories || [])]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/product-categories/:id", authRequired, adminRequired, async (req, res) => {
    try {
        if (req.body.title && !req.body.slug) {
            req.body.slug = generateSlug(req.body.title);
        }
        const updated = await dynamicUpdate('product_categories', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found or No changes" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/product-categories/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const { rows } = await pool.query("DELETE FROM product_categories WHERE id=$1 RETURNING *", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ---------------------------------------------------------
// 🟢 2. หมวดหมู่บริการ (Service Categories)
// ---------------------------------------------------------
app.get("/api/service-categories", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM service_categories ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/service-categories", authRequired, adminRequired, async (req, res) => {
    try {
        const { title, sort_order, is_active } = req.body;
        const slug = generateSlug(title, req.body.slug);

        const { rows } = await pool.query(
            `INSERT INTO service_categories (title, slug, sort_order, is_active) VALUES ($1, $2, $3, $4) RETURNING *`,
            [title, slug, sort_order || 0, is_active ?? true]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/service-categories/:id", authRequired, adminRequired, async (req, res) => {
    try {
        if (req.body.title && !req.body.slug) {
            req.body.slug = generateSlug(req.body.title);
        }
        const updated = await dynamicUpdate('service_categories', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/service-categories/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const { rows } = await pool.query("DELETE FROM service_categories WHERE id=$1 RETURNING *", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------
// 🟢 3. เมนูรวม
// ---------------------------------------------------------
app.get("/api/site/menu", async (req, res) => {
    try {
        const p = await pool.query("SELECT id, title, slug, subcategories FROM product_categories WHERE is_active=true ORDER BY sort_order");
        const s = await pool.query("SELECT id, title, slug FROM service_categories WHERE is_active=true ORDER BY sort_order");
        res.json({ products: p.rows, services: s.rows });
    } catch (e) { res.status(500).json({ error: "Menu Error" }); }
});

// ---------------------------------------------------------
// 📦 4. สินค้า (Products) - UPDATED & FIXED
// ---------------------------------------------------------
app.get("/api/products", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM products ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/products/:id", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM products WHERE id=$1", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ POST: รองรับ subcategory, cta_url และแก้ bug sort_order เป็น null
app.post("/api/products", authRequired, adminRequired, async (req, res) => {
    try {
        const { category, subcategory, name, description, image_url, sort_order, is_active, cta_url } = req.body;

        // Validation เบื้องต้น
        if (!category || !name) {
            return res.status(400).json({ message: "Category and Name are required" });
        }

        const { rows } = await pool.query(
            `INSERT INTO products (category, subcategory, name, description, image_url, sort_order, is_active, cta_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                category,
                subcategory || "", // ถ้าไม่มีให้เป็น string ว่าง
                name,
                description || "",
                image_url || "",
                sort_order || 0,   // ✅ Fix: ถ้าไม่มีค่า ให้ใส่ 0 (ป้องกัน error not-null)
                is_active ?? true,
                cta_url || ""      // ✅ เพิ่ม: บันทึก Link CTA
            ]
        );
        res.json(rows[0]);
    } catch (e) {
        console.error("Insert Product Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ✅ PATCH: รองรับ subcategory และ cta_url ผ่าน Dynamic Update
app.patch("/api/products/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const updated = await dynamicUpdate('products', req.params.id, req.body);

        if (!updated) return res.status(404).json({ message: "Not found or No changes" });
        res.json(updated);
    } catch (e) {
        console.error("Update Product Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/products/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const { rows } = await pool.query("DELETE FROM products WHERE id=$1 RETURNING *", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------
// 🛠 5. บริการ (Services)
// ---------------------------------------------------------
app.get("/api/services", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM services ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/services/:id", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM services WHERE id=$1", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/services", authRequired, adminRequired, async (req, res) => {
    try {
        const { title, description, image_url, sort_order, is_active } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO services (title, description, image_url, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [title, description, image_url, sort_order, is_active]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/services/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const updated = await dynamicUpdate('services', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/services/:id", authRequired, adminRequired, async (req, res) => {
    try {
        await pool.query("DELETE FROM services WHERE id=$1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------
// 📰 6. ข่าวสาร (News)
// ---------------------------------------------------------
app.get("/api/news", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM news ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/news/:id", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM news WHERE id=$1", [req.params.id]);
        if (!rows.length) return res.status(404).json({ message: "Not found" });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/news", authRequired, adminRequired, async (req, res) => {
    try {
        const { title, content, image_url, sort_order, is_active } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO news (title, content, image_url, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [title, content, image_url, sort_order, is_active]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/news/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const updated = await dynamicUpdate('news', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/news/:id", authRequired, adminRequired, async (req, res) => {
    try {
        await pool.query("DELETE FROM news WHERE id=$1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------
// 🏆 7. ใบรับรอง (Certifications)
// ---------------------------------------------------------
app.get("/api/certifications", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM certifications ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/certifications", authRequired, adminRequired, async (req, res) => {
    try {
        const { title, image_url, sort_order } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO certifications (title, image_url, sort_order) VALUES ($1, $2, $3) RETURNING *`,
            [title, image_url, sort_order]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/certifications/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const updated = await dynamicUpdate('certifications', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/certifications/:id", authRequired, adminRequired, async (req, res) => {
    try {
        await pool.query("DELETE FROM certifications WHERE id=$1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------
// 🖼 8. โลโก้ลูกค้า (Customer Logos)
// ---------------------------------------------------------
app.get("/api/customer-logos", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM customer_logos ORDER BY sort_order ASC");
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/customer-logos", authRequired, adminRequired, async (req, res) => {
    try {
        const { name, image_url, sort_order } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO customer_logos (name, image_url, sort_order) VALUES ($1, $2, $3) RETURNING *`,
            [name, image_url, sort_order]
        );
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/customer-logos/:id", authRequired, adminRequired, async (req, res) => {
    try {
        const updated = await dynamicUpdate('customer_logos', req.params.id, req.body);
        if (!updated) return res.status(404).json({ message: "Not found" });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/customer-logos/:id", authRequired, adminRequired, async (req, res) => {
    try {
        await pool.query("DELETE FROM customer_logos WHERE id=$1", [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---------------------------------------------------------
// 📞 9. หน้าติดต่อเรา (Contact Page)
// ---------------------------------------------------------
app.get("/api/site/contact", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM contact_page WHERE id=1");
        // ถ้ายังไม่มีข้อมูล ให้ส่ง object ว่างๆ กลับไป
        const data = rows[0] || {};
        res.json({ data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/site/contact", authRequired, adminRequired, async (req, res) => {
    try {
        // รับค่าจาก { data: { ... } } ตามที่ Frontend ส่งมา
        const {
            heading, description, email, phone,
            line_label, line_url, line_icon_url,
            address_lines, open_hours, map_title, map_embed_url
        } = req.body.data;

        // ใช้ UPSERT: ถ้ามี ID=1 ให้ Update ถ้าไม่มีให้ Insert
        const query = `
            INSERT INTO contact_page (
                id, heading, description, email, phone,
                line_label, line_url, line_icon_url,
                address_lines, open_hours, map_title, map_embed_url
            )
            VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
            ON CONFLICT (id) DO UPDATE SET
                heading = EXCLUDED.heading,
                description = EXCLUDED.description,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                line_label = EXCLUDED.line_label,
                line_url = EXCLUDED.line_url,
                line_icon_url = EXCLUDED.line_icon_url,
                address_lines = EXCLUDED.address_lines,
                open_hours = EXCLUDED.open_hours,
                map_title = EXCLUDED.map_title,
                map_embed_url = EXCLUDED.map_embed_url,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;

        const values = [
            heading, description, email, phone,
            line_label, line_url, line_icon_url,
            JSON.stringify(address_lines || []), // แปลง Array เป็น JSON String
            open_hours, map_title, map_embed_url
        ];

        const { rows } = await pool.query(query, values);
        res.json({ data: rows[0] });
    } catch (e) {
        console.error("Update Contact Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});