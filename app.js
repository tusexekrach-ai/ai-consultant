/**
 * Frontend ของแชทบอท "AI ที่ปรึกษาด้านธุรกิจ"
 * - ส่งประวัติแชทไปที่ /api/chat และแสดงคำตอบ
 * - ไม่มี API key ในไฟล์นี้ (key อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น)
 */
(() => {
  'use strict';

  const API_URL = '/api/chat';
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

  /** ประวัติที่ส่งให้ API: [{ role: 'user' | 'assistant', content: string }] (ไม่รวมข้อความทักทาย) */
  let history = [];
  let busy = false;

  // ---------- Markdown แบบปลอดภัย (escape HTML ก่อนเสมอ) ----------
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  const splitRow = (line) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

  function renderMarkdown(src) {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // code block
      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      // blank
      if (!line.trim()) { i++; continue; }

      // horizontal rule
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = Math.min(h[1].length + 1, 4); // # -> h2 ... เพื่อไม่ให้หัวข้อใหญ่เกิน
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
            head.map((c) => `<th>${inline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
            '</tbody></table></div>'
        );
        continue;
      }

      // unordered list
      if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
        out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
        continue;
      }

      // paragraph (รวมบรรทัดต่อเนื่องเข้าด้วยกัน)
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*[-*•]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // ---------- UI helpers ----------
  function scrollToBottom() {
    $messages.scrollTop = $messages.scrollHeight;
  }

  function addMessage(role, content, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role === 'user' ? 'user' : 'bot'}${opts.error ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user' || opts.error) {
      bubble.textContent = content; // ข้อความผู้ใช้/ข้อผิดพลาดแสดงเป็นข้อความล้วน
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
    wrap.innerHTML =
      '<div class="bubble" aria-label="AI กำลังพิมพ์"><span class="typing"><span></span><span></span><span></span></span></div>';
    $messages.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function setBusy(state) {
    busy = state;
    $send.disabled = state;
    $input.setAttribute('aria-busy', String(state));
  }

  function autoGrow() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 160) + 'px';
  }

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      /* ไม่เป็นไรถ้าบันทึกไม่ได้ */
    }
  }

  function load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      );
    } catch {
      return [];
    }
  }

  // ---------- เรียก Backend ----------
  async function requestReply() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        /* ตอบกลับไม่ใช่ JSON */
      }

      if (!res.ok) {
        throw new Error((data && data.error) || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
      }
      if (!data || typeof data.reply !== 'string') {
        throw new Error('ได้รับข้อมูลตอบกลับที่ไม่ถูกต้อง');
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง');
      if (err instanceof TypeError) throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getReply() {
    setBusy(true);
    const typing = addTyping();
    try {
      const data = await requestReply();
      typing.remove();
      history.push({ role: 'assistant', content: data.reply });
      save();
      const { bubble } = addMessage('assistant', data.reply);
      if (data.truncated) {
        const note = document.createElement('p');
        note.className = 'notice';
        note.textContent = 'คำตอบยาวและถูกตัดตอน พิมพ์ "ช่วยต่อให้หน่อย" เพื่อให้ผมตอบต่อได้ครับ';
        bubble.appendChild(note);
      }
    } catch (err) {
      typing.remove();
      showError(err.message);
    } finally {
      setBusy(false);
      $input.focus();
    }
  }

  function showError(message) {
    const { bubble, wrap } = addMessage('assistant', message, { error: true });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'retry-btn';
    btn.textContent = 'ลองอีกครั้ง';
    btn.addEventListener('click', () => {
      if (busy) return;
      wrap.remove();
      getReply();
    });
    bubble.appendChild(document.createElement('br'));
    bubble.appendChild(btn);
  }

  async function sendMessage(text) {
    const content = text.trim();
    if (!content || busy) return;

    $chips.hidden = true;
    addMessage('user', content);
    history.push({ role: 'user', content });
    save();

    $input.value = '';
    autoGrow();
    await getReply();
  }

  // ---------- Events ----------
  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage($input.value.slice(0, MAX_INPUT));
  });

  $input.addEventListener('keydown', (e) => {
    // isComposing: ป้องกันการส่งตอนกำลังเลือกตัวอักษรด้วย IME (ไทย/ญี่ปุ่น/จีน)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      $form.requestSubmit();
    }
  });
  $input.addEventListener('input', autoGrow);

  $chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) sendMessage(chip.dataset.text || chip.textContent);
  });

  $reset.addEventListener('click', () => {
    if (busy) return;
    if (history.length && !confirm('เริ่มบทสนทนาใหม่? ประวัติแชทปัจจุบันจะถูกลบ')) return;
    history = [];
    save();
    init();
  });

  // ---------- Init ----------
  function init() {
    $messages.innerHTML = '';
    addMessage('assistant', GREETING);
    history = load();
    for (const m of history) addMessage(m.role, m.content);
    $chips.hidden = history.length > 0;

    // ถ้าค้างอยู่ที่ข้อความผู้ใช้ (รีเฟรชระหว่างรอคำตอบ) ให้ขอคำตอบต่อ
    if (history.length && history[history.length - 1].role === 'user') getReply();
    else $input.focus();
  }

  init();
})();
