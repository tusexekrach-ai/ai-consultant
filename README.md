# AI ที่ปรึกษาด้านธุรกิจ

```
ai-business-advisor/
├── api/chat.js            # Backend: เรียก Gemini API (Vercel Serverless / Node)
├── lib/systemPrompt.js    # System Prompt (ตรรกะความคิดของที่ปรึกษา)
├── public/
│   ├── index.html         # หน้าแชท
│   ├── style.css
│   └── app.js             # ส่ง-รับข้อความกับ /api/chat
├── server.js              # เซิร์ฟเวอร์ Node.js/Express (ใช้เมื่อไม่ได้อยู่บน Vercel)
├── vercel.json
├── package.json
└── .env.example
```

## รันบนเครื่อง (Node.js)
```bash
npm install
cp .env.example .env      # แล้วใส่ GEMINI_API_KEY (ขอฟรีที่ https://aistudio.google.com/apikey)
npm start                 # เปิด http://localhost:3000
```

## Deploy บน Vercel
```bash
npm i -g vercel
vercel                    # ทำตามขั้นตอน
vercel env add GEMINI_API_KEY   # ใส่ key ทั้ง Production/Preview
vercel --prod
```
หรือ Import repo ใน Vercel Dashboard แล้วเพิ่ม Environment Variable `GEMINI_API_KEY` ที่ Settings > Environment Variables

## ปรับแต่ง
- บุคลิก/ขั้นตอนการถาม-วิเคราะห์: แก้ `lib/systemPrompt.js`
- โมเดล/ความยาวคำตอบ: `GEMINI_MODEL`, `MAX_TOKENS`
- ธีมสี/หน้าตา: ตัวแปร CSS ที่ต้น `public/style.css`

## เรื่องที่ควรรู้เกี่ยวกับ Gemini Free Tier
- โควตาจำกัดต่อนาที/ต่อวัน และรายชื่อโมเดลที่ใช้ฟรีเปลี่ยนได้ ตรวจที่ Google AI Studio (หน้า rate limit)
- ตามเงื่อนไขของ Google ข้อมูลที่ส่งผ่าน Free Tier อาจถูกนำไปปรับปรุงผลิตภัณฑ์ของ Google
  จึงไม่ควรให้ผู้ใช้กรอกข้อมูลลับ/ข้อมูลส่วนบุคคลของลูกค้า ถ้าต้องการหลีกเลี่ยงให้ใช้แบบชำระเงิน
- ถ้าเจอ error 429 บ่อย ลดค่า `RATE_LIMIT_PER_MIN` หรือเปลี่ยน `GEMINI_MODEL` เป็นรุ่นที่โควตาสูงกว่า
