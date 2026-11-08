/**
 * Frontend ของแชทบอท "AI ที่ปรึกษาด้านธุรกิจ" (เวอร์ชันแก้ปัญหาท่อเชื่อม API ยิงตรงหา Gemini)
 */
(() => {
  'use strict';

  // ดึงข้อความคีย์ที่กรอกบนหน้าเว็บ หรือใช้ผ่านที่ระบบบันทึกไว้
  const getApiKey = () => localStorage.getItem('gemini_api_key_custom') || '';
  
  const STORAGE_KEY = 'business_advisor_chat_v1';
  const FETCH_TIMEOUT_MS = 60_000;
  const MAX_INPUT = 4000;

  const GREETING =
    'สวัสดีครับ ผมคือที่ปรึกษาธุรกิจ AI 👋\n\n' +
    'ก่อนจะแนะนำอะไร ผมขอทำความเข้าใจธุรกิจของคุณก่อน เพื่อให้คำแนะนำตรงกับสถานการณ์จริง ไม่ใช่คำตอบกว้างๆ\n\n' +
    'เริ่มจากสองข้อนี้ได้เลยครับ:\n' +
    '1. ธุรกิจของคุณทำอะไร ขายให้ใคร\n' +
    '2. ตอนนี้อยากให้ธุรกิจไปถึงจุดไหน หรืออยากแก้ปัญหาอะไรเป็นพิเศษ';

  const $messages = document.getElementById('messages');
  const $form = document.getElementById('chatForm');
  const $input = document.getElementById('input');
  const $send = document.getElementById('sendBtn');
  const $reset = document.getElementById('resetBtn');
  const $chips = document.getElementById('chips');

  // เพิ่มการสร้างปุ่มตั้งค่าคีย์บนหน้าเว็บกรณีที่ระบบเรียกหา
  let $settingBtn = document.getElementById('resetBtn');

  let history = [];
  let busy = false;

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]+)`/g, '<code>\$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>\$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '\$1<em>\$2</em>');
  }

  const splitRow = (line) =>
    line.trim().replace(/^\|/, '').replace(/\|\$/, '').split('|').map((c) => c.trim());
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*\$/.test(line);

  function renderMarkdown(src) {
    const lines = src.replace(\(/\r\\)n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*\$/.test(line)) { out.push('<hr>'); i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)\$/);
      if (h) {
        const level = Math.min(h[1].length + 1, 4);
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + rows.map((r) => `<tr>${r.map((c) => `<td>\${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
        out.push(`<ul>${items.map((t) => `<li>\${inline(t)}</li>`).join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push(`<ol>${items.map((t) => `<li>\${inline(t)}</li>`).join('')}</ol>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*•]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
        para.push(lines[i++]);
      }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function scrollToBottom() { $messages.scrollTop = $messages.scrollHeight; }

  function addMessage(role, content, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role === 'user' ? 'user' : 'bot'}${opts.error ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user' || opts.error) {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
    scrollToBottom();
    return { wrap, bubble };
  }

  function addTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.innerHTML = '<div class="bubble" aria-label="AI กำลังพิมพ์"><span class="typing"><span></span><span></span><span></span></span></div>';
    $messages.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function setBusy(state) {
    busy = state;
    $send.disabled = state;
    $input.disabled = state;
  }

  // ปรับการดึงสัญญาณ API ยิงตรงหาสมอง Gemini แบบไร้เซิร์ฟเวอร์
  async function requestReply() {
    const key = getApiKey();
    if (!key) {
      throw new Error('ไม่พบ API Key กรุณากดปุ่ม "เริ่มใหม่" ค้างไว้ หรือคลิกตั้งค่าใส่คีย์ Gemini อีกครั้ง');
    }

    const sysPrompt = "คุณคือ AI ที่ปรึกษาด้านธุรกิจที่เชี่ยวชาญกลยุทธ์การตลาด วิเคราะห์ต้นทุน ต้องสัมภาษณ์ข้อมูลลูกค้าก่อนเสมอ";
    
    // แปลงประวัติของระบบให้เข้ากับฟอร์แมตโครงสร้างข้อมูลของข้อกำหนดภาษาของกูเกิล
    const contents = history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    const targetUrl = `https://googleapis.com{key}`;
    
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: { parts: [{ text: sysPrompt }] }
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `การเชื่อมต่อถูกปฏิเสธ (HTTP ${res.status})`);
    }

    const data = await res.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!replyText) throw new Error('โครงสร้างคำตอบรับจากกูเกิลไม่สอดคล้อง');
    return { reply: replyText };
  }

  async function getReply() {
    setBusy(true);
    const typing = addTyping();
    try {
      const data = await requestReply();
      typing.remove();
      history.push({ role: 'assistant', content: data.reply });
      save();
      addMessage('assistant', data.reply);
    } catch (err) {
      typing.remove();
      addMessage('assistant', `เกิดข้อผิดพลาด: ${err.message}`, { error: true });
    } finally {
      setBusy(false);
    }
  }

  function handleSend(e) {
    if (e) e.preventDefault();
    if (busy) return;
    const txt = $input.value.trim();
    if (!txt) return;
    $input.value = '';
    $input.style.height = 'auto';
    history.push({ role: 'user', content: txt });
    save();
    addMessage('user', txt);
    getReply();
  }

  // เติมฟังก์ชันดึงหน้าต่างตั้งค่าแบบด่วนในกรณีหาคีย์ไม่เจอ
  window.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'resetBtn') {
      const current = localStorage.getItem('gemini_api_key_custom') || '';
      const newKey = prompt('กรุณากรอกรหัส Gemini API Key เพื่อเริ่มต้นคุยบอท:', current);
      if (newKey !== null) {
        localStorage.setItem('gemini_api_key_custom', newKey.trim());
        alert('บันทึกคีย์เรียบร้อยแล้ว ลองส่งข้อความคุยได้เลยครับ!');
      }
    }
  });

  $form.addEventListener('submit', handleSend);
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = $input.scrollHeight + 'px';
  });

  // โหลดเริ่มต้นข้อความทักทาย
  addMessage('assistant', GREETING);
})();
