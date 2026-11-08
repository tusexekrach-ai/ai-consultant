/**
 * แชทบอท "AI ที่ปรึกษาด้านธุรกิจ" (Client-side: เรียก Gemini API จากเบราว์เซอร์โดยตรง ไม่มี backend)
 * - ต้องโหลด config.js และ systemPrompt.js ก่อนไฟล์นี้ (ดู index.html)
 * - API key มาจาก 2 ที่: key ที่ผู้ใช้กรอกเอง (เก็บใน localStorage) หรือ config.js
 */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const SYSTEM_PROMPT = window.SYSTEM_PROMPT || '';
  const MODEL = CFG.GEMINI_MODEL || 'gemini-2.5-flash';
  const MAX_TOKENS = Number(CFG.MAX_TOKENS) || 4096;
  const TEMPERATURE = CFG.TEMPERATURE !== undefined ? Number(CFG.TEMPERATURE) : 0.7;
  const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

  const STORAGE_KEY = 'business_advisor_chat_v1';
  const KEY_STORAGE = 'business_advisor_gemini_key_v1';
  const FETCH_TIMEOUT_MS = 60_000;
  const MAX_INPUT = 4000;
  const MAX_MESSAGES = 40;

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
  const $settings = document.getElementById('settingsBtn');
  const $keyDialog = document.getElementById('keyDialog');
  const $keyForm = document.getElementById('keyForm');
  const $keyInput = document.getElementById('keyInput');
  const $keyNote = document.getElementById('keyNote');
  const $keyClear = document.getElementById('keyClear');
  const $keyCancel = document.getElementById('keyCancel');

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

  // ---------- API key ----------
  function getSavedKey() {
    try {
      return (localStorage.getItem(KEY_STORAGE) || '').trim();
    } catch {
      return '';
    }
  }
  const getApiKey = () => getSavedKey() || String(CFG.GEMINI_API_KEY || '').trim();

  function openKeyDialog() {
    const saved = getSavedKey();
    const hasConfigKey = Boolean(String(CFG.GEMINI_API_KEY || '').trim());
    $keyInput.value = '';
    $keyInput.placeholder = saved ? 'มี key ที่บันทึกไว้แล้ว (กรอกใหม่เพื่อแทนที่)' : 'วาง Gemini API key ที่นี่';
    $keyClear.hidden = !saved;
    $keyNote.textContent = hasConfigKey && !saved
      ? 'เว็บนี้มี key ตั้งไว้ให้แล้ว คุณไม่จำเป็นต้องกรอกเอง แต่ถ้ากรอก ระบบจะใช้ key ของคุณแทน'
      : '';
    if (typeof $keyDialog.showModal === 'function') $keyDialog.showModal();
    else $keyDialog.setAttribute('open', '');
    $keyInput.focus();
  }

  function closeKeyDialog() {
    if (typeof $keyDialog.close === 'function') $keyDialog.close();
    else $keyDialog.removeAttribute('open');
  }

  // ---------- เรียก Gemini API โดยตรง ----------
  /** เตรียมประวัติแชท: จำกัดจำนวน/ความยาว, ตัดข้อความ assistant นำหน้า, รวมข้อความที่ role ซ้ำติดกัน */
  function buildContents() {
    const msgs = history
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: String(m.content).trim().slice(0, MAX_INPUT) }))
      .filter((m) => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();

    const contents = [];
    for (const m of msgs) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += `\n\n${m.content}`;
      else contents.push({ role, parts: [{ text: m.content }] });
    }
    return contents;
  }

  const SAFETY_MSG = 'ขออภัย ระบบไม่สามารถตอบข้อความนี้ได้ ลองปรับถ้อยคำแล้วส่งใหม่อีกครั้ง';

  async function requestReply() {
    const apiKey = getApiKey();
    if (!apiKey) {
      openKeyDialog();
      throw new Error('ยังไม่ได้ตั้งค่า Gemini API key กรุณากรอก key แล้วกด "ลองอีกครั้ง"');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: buildContents(),
          generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: TEMPERATURE },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // รายละเอียดจริงดูได้ใน DevTools > Console
        const detail = await res.text().catch(() => '');
        console.error('Gemini API error', res.status, detail.slice(0, 500));
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          if (!getSavedKey()) { /* key มาจาก config.js */ } else openKeyDialog();
          throw new Error('API key ไม่ถูกต้อง หมดอายุ หรือไม่ได้รับอนุญาตให้ใช้งานจากเว็บนี้ กรุณาตรวจสอบ key ในปุ่ม "ตั้งค่า"');
        }
        if (res.status === 429) throw new Error('โควตาการใช้งาน AI ในขณะนี้เต็มแล้ว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง');
        if (res.status === 503) throw new Error('ขณะนี้มีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้งในอีกสักครู่');
        throw new Error('ไม่สามารถเชื่อมต่อระบบ AI ได้ในขณะนี้ กรุณาลองใหม่');
      }

      const data = await res.json();
      if (data.promptFeedback && data.promptFeedback.blockReason) throw new Error(SAFETY_MSG);

      const candidate = data.candidates && data.candidates[0];
      const reply = ((candidate && candidate.content && candidate.content.parts) || [])
        .filter((part) => typeof part.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('')
        .trim();

      if (!reply) {
        console.error('Gemini empty reply, finishReason =', candidate && candidate.finishReason);
        if (candidate && (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT')) {
          throw new Error(SAFETY_MSG);
        }
        throw new Error('ไม่ได้รับคำตอบจาก AI กรุณาลองใหม่');
      }
      return { reply, truncated: candidate.finishReason === 'MAX_TOKENS' };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง');
      if (err instanceof TypeError) throw new Error('เชื่อมต่อ AI ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
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
    if (!getApiKey()) {
      openKeyDialog(); // ยังไม่มี key: เก็บข้อความไว้ในช่องพิมพ์ ยังไม่ส่ง
      return;
    }

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

  $settings.addEventListener('click', openKeyDialog);
  $keyCancel.addEventListener('click', closeKeyDialog);
  $keyClear.addEventListener('click', () => {
    try { localStorage.removeItem(KEY_STORAGE); } catch { /* ไม่เป็นไร */ }
    closeKeyDialog();
  });
  $keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $keyInput.value.trim();
    if (key.length < 20 || /\s/.test(key)) {
      $keyInput.setCustomValidity('รูปแบบ key ไม่ถูกต้อง');
      $keyInput.reportValidity();
      $keyInput.setCustomValidity('');
      return;
    }
    try {
      localStorage.setItem(KEY_STORAGE, key);
    } catch {
      alert('บันทึก key ไม่ได้ (เบราว์เซอร์อาจปิดการเก็บข้อมูล) key จะใช้ได้เฉพาะรอบนี้เท่านั้น');
      CFG.GEMINI_API_KEY = key;
    }
    closeKeyDialog();
    $input.focus();
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
