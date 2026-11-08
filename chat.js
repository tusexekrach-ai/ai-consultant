/**
 * POST /api/chat
 * รับประวัติแชทจากหน้าเว็บ -> เรียก Gemini API (Google AI Studio) ฝั่งเซิร์ฟเวอร์เท่านั้น -> ส่งคำตอบกลับ
 *
 * ใช้ได้ทั้งบน Vercel Serverless Function และ Node.js/Express (ดู server.js)
 * API key อ่านจาก process.env.GEMINI_API_KEY เท่านั้น ห้ามใส่ในโค้ดหน้าเว็บ
 *
 * หมายเหตุ: รูปแบบ request/response ระหว่างหน้าเว็บกับไฟล์นี้ไม่เปลี่ยน
 *   request : { messages: [{ role: 'user' | 'assistant', content: string }] }
 *   response: { reply: string, truncated: boolean }  หรือ { error: string }
 */

const { SYSTEM_PROMPT } = require('../lib/systemPrompt');

// ---------- ค่าตั้งต้น (ปรับผ่าน Environment Variables ได้) ----------
// ชื่อโมเดลและสิทธิ์ใช้ฟรีเปลี่ยนได้ตามเวลา ตรวจรายการล่าสุดที่ https://aistudio.google.com
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// โมเดลแบบ "คิดก่อนตอบ" นับโทเคนที่ใช้คิดรวมใน maxOutputTokens จึงตั้งค่าเผื่อไว้สูงกว่าเดิม
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 4096;
const TEMPERATURE = process.env.TEMPERATURE !== undefined ? Number(process.env.TEMPERATURE) : 0.7;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_MESSAGES = 40; // จำนวนข้อความย้อนหลังสูงสุดที่รับต่อคำขอ
const MAX_CHARS_PER_MESSAGE = 4000; // ความยาวสูงสุดต่อข้อความ
const REQUEST_TIMEOUT_MS = 55_000;

// ---------- Rate limit แบบง่าย (ต่อ IP) ----------
// Free Tier ของ Gemini มีโควตาต่อนาที/ต่อวันจำกัด การกันรัวฝั่งเราช่วยประหยัดโควตาได้ระดับหนึ่ง
// หมายเหตุ: บน Serverless หน่วยความจำไม่ถูกแชร์ข้ามอินสแตนซ์ จึงเป็นเพียงด่านกันรัวเบื้องต้น
// ถ้าเปิดใช้งานจริงจังควรใช้ Upstash Redis / Vercel KV แทน
const RATE_LIMIT = { windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 10 };
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  // กันไม่ให้ Map โตไม่จำกัด
  if (hits.size > 5000) {
    for (const [key, value] of hits) {
      if (now - value.start > RATE_LIMIT.windowMs) hits.delete(key);
    }
  }
  return entry.count > RATE_LIMIT.max;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ---------- ตรวจและทำความสะอาดข้อความจากผู้ใช้ ----------
function sanitizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;

  const cleaned = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, MAX_CHARS_PER_MESSAGE);
    if (!content) continue;
    cleaned.push({ role: m.role, content });
  }

  // ต้องเริ่มด้วย user และข้อความสุดท้ายต้องเป็น user
  while (cleaned.length && cleaned[0].role !== 'user') cleaned.shift();
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== 'user') return null;

  return cleaned;
}

/**
 * แปลงเป็นรูปแบบของ Gemini: role 'assistant' -> 'model', ข้อความอยู่ใน parts[]
 * และรวมข้อความที่ role ซ้ำติดกัน (เช่น ผู้ใช้กด "ลองอีกครั้ง" แล้วพิมพ์ใหม่)
 * เพราะ Gemini ต้องการให้ผลัดกันระหว่าง user กับ model
 */
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += `\n\n${m.content}`;
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }
  return contents;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return null;
      }
    }
    return req.body;
  }
  return null;
}

// ---------- Handler หลัก ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  // (ทางเลือก) จำกัดให้เรียกจากโดเมนของคุณเท่านั้น เช่น ALLOWED_ORIGIN=https://your-site.com
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin && req.headers.origin && req.headers.origin !== allowedOrigin) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set');
    return sendJson(res, 500, { error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่าระบบ AI กรุณาติดต่อผู้ดูแล' });
  }

  if (isRateLimited(getClientIp(req))) {
    return sendJson(res, 429, { error: 'ส่งข้อความถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' });
  }

  const body = readBody(req);
  const messages = sanitizeMessages(body?.messages);
  if (!messages) {
    return sendJson(res, 400, { error: 'รูปแบบข้อความไม่ถูกต้อง' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(MODEL)}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // ส่ง key ทาง header (ไม่ใส่ใน URL) เพื่อไม่ให้ key ไปปรากฏใน log
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: toGeminiContents(messages),
        generationConfig: {
          maxOutputTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // log รายละเอียดฝั่งเซิร์ฟเวอร์ แต่ไม่ส่งรายละเอียดภายในให้ผู้ใช้
      const detail = await upstream.text().catch(() => '');
      console.error('Gemini API error', upstream.status, detail.slice(0, 500));

      if (upstream.status === 429) {
        return sendJson(res, 503, {
          error: 'โควตาการใช้งาน AI ในขณะนี้เต็มแล้ว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
        });
      }
      if (upstream.status === 503) {
        return sendJson(res, 503, { error: 'ขณะนี้มีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้งในอีกสักครู่' });
      }
      return sendJson(res, 502, { error: 'ไม่สามารถเชื่อมต่อระบบ AI ได้ในขณะนี้ กรุณาลองใหม่' });
    }

    const data = await upstream.json();

    // ถูกบล็อกตั้งแต่ตอนรับ prompt
    if (data.promptFeedback?.blockReason) {
      console.error('Gemini prompt blocked', data.promptFeedback.blockReason);
      return sendJson(res, 422, { error: 'ขออภัย ระบบไม่สามารถตอบข้อความนี้ได้ ลองปรับถ้อยคำแล้วส่งใหม่อีกครั้ง' });
    }

    const candidate = data.candidates?.[0];
    const reply = (candidate?.content?.parts || [])
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('')
      .trim();

    if (!reply) {
      console.error('Gemini empty reply, finishReason =', candidate?.finishReason);
      if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
        return sendJson(res, 422, { error: 'ขออภัย ระบบไม่สามารถตอบข้อความนี้ได้ ลองปรับถ้อยคำแล้วส่งใหม่อีกครั้ง' });
      }
      return sendJson(res, 502, { error: 'ไม่ได้รับคำตอบจาก AI กรุณาลองใหม่' });
    }

    return sendJson(res, 200, { reply, truncated: candidate?.finishReason === 'MAX_TOKENS' });
  } catch (err) {
    if (err.name === 'AbortError') {
      return sendJson(res, 504, { error: 'AI ใช้เวลาตอบนานเกินไป กรุณาลองใหม่อีกครั้ง' });
    }
    console.error('Unexpected error', err);
    return sendJson(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่' });
  } finally {
    clearTimeout(timer);
  }
};
