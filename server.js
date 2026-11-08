/**
 * เซิร์ฟเวอร์ Node.js สำหรับรันบนเครื่อง/VPS (ไม่จำเป็นถ้าใช้ Vercel)
 * รัน: npm start   (ต้องมีไฟล์ .env และ Node.js 20.6 ขึ้นไป)
 */

const path = require('path');
const express = require('express');
const chatHandler = require('./api/chat');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // ให้อ่าน IP จริงเมื่ออยู่หลัง reverse proxy

app.use(express.json({ limit: '100kb' }));

// Security headers พื้นฐาน
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.post('/api/chat', chatHandler);
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AI Business Advisor running at http://localhost:${port}`);
});
