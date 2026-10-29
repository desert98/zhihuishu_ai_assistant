// ==UserScript==
// @name         Zhihuishu AI Automation Assistant
// @namespace    local.zhihuishu.ai
// @version      8.0.0
// @description  Custom API base URL / key, auto answer selection and next-question navigation
// @match        *://*.zhihuishu.com/*
// @match        *://*.zhihuishu.cn/*
// @match        *://*.zhihuishu.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const PANEL_ID = "zh-ai-automation";

  const KEY_BASE_URL = "zhai:baseUrl";
  const KEY_API_KEY = "zhai:apiKey";
  const KEY_MODEL = "zhai:model";
  const KEY_DELAY = "zhai:delayMs";
  const KEY_AUTO_NEXT = "zhai:autoNext";
  const KEY_AUTO_SUBMIT = "zhai:autoSubmit";
  const KEY_RUNNING = "zhai:running";

  const DEFAULT_BASE_URL = "https://api.deepseek.com";
  const DEFAULT_MODEL = "deepseek-chat";

  let busy = false;
  let requestId = 0;
  let lastSignature = "";

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- settings ----------

  function getSetting(key, fallback) {
    const v = GM_getValue(key);
    return v === undefined || v === null ? fallback : v;
  }

  const getBaseUrl = () => String(getSetting(KEY_BASE_URL, DEFAULT_BASE_URL)).trim() || DEFAULT_BASE_URL;
  const getApiKey = () => String(getSetting(KEY_API_KEY, "")).trim();
  const getModel = () => String(getSetting(KEY_MODEL, DEFAULT_MODEL)).trim() || DEFAULT_MODEL;
  const getDelayMs = () => Math.max(0, Number(getSetting(KEY_DELAY, 1500)) || 0);
  const getAutoNext = () => getSetting(KEY_AUTO_NEXT, true) !== false;
  const getAutoSubmit = () => getSetting(KEY_AUTO_SUBMIT, true) !== false;
  const isRunning = () => getSetting(KEY_RUNNING, false) === true;
  const setRunning = v => GM_setValue(KEY_RUNNING, !!v);

  // Accepts bare host, OpenAI-style /v1 base, or a full chat/completions URL.
  function normalizeApiUrl(input) {
    let u = String(input || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v\d+$/i.test(u)) return u + "/chat/completions";
    return u + "/v1/chat/completions";
  }

  // ---------- dom extraction ----------

  function textOf(el) {
    return (el?.innerText || el?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function questionContainer() {
    const primary = $$(".questionContent").find(el =>
      el.querySelector(".questionName .centent-pre pre")
    );
    return primary || $(".questionContent") || $(".TiMu") || null;
  }

  function detectType(rawText, container) {
    const t = rawText || "";
    if (t.includes("单选")) return "single_choice";
    if (t.includes("多选")) return "multiple_choice";
    if (t.includes("判断")) return "true_false";
    if ($("input[type=radio]", container)) return "single_choice";
    if ($("input[type=checkbox]", container)) return "multiple_choice";
    return "unknown";
  }

  function stripLetterPrefix(t) {
    const m = String(t).match(/^\(?([A-Za-z])\)?\s*[.．、:：]?\s*(.*)$/);
    if (!m) return { letter: "", text: String(t).trim() };
    return { letter: m[1].toUpperCase(), text: m[2].trim() };
  }

  function isSelected(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute("aria-checked") === "true") return true;
    if (
      el.classList.contains("is-checked") ||
      el.classList.contains("checked") ||
      el.classList.contains("checkedIcon") ||
      el.classList.contains("active") ||
      el.classList.contains("selected") ||
      el.classList.contains("on")
    ) {
      return true;
    }
    const input = el.querySelector("input[type=radio],input[type=checkbox]");
    if (input) return input.checked;
    if (el.querySelector(".checkIcon.checkedIcon, .checkedIcon, .icon-checked")) return true;
    return false;
  }

  function strategyRadioView(container) {
    const items = $$("ul.radio-view > li", container);
    if (!items.length) return null;
    return items.map(li => ({
      letter: textOf(li.querySelector(".letterSort")).replace(/[.．、:：\s]/g, "").toUpperCase(),
      text: textOf(li.querySelector(".stem")) || stripLetterPrefix(textOf(li)).text,
      el: li,
      selected: isSelected(li)
    }));
  }

  function strategyCheckbox(container) {
    const labels = $$(".el-checkbox-group > label.el-checkbox", container);
    if (!labels.length) return null;
    return labels.map(label => ({
      letter: textOf(label.querySelector(".el-checkbox__label .letterSort"))
        .replace(/[.．、:：\s]/g, "").toUpperCase(),
      text: textOf(label.querySelector(".el-checkbox__label pre")) || stripLetterPrefix(textOf(label)).text,
      el: label,
      selected: isSelected(label)
    }));
  }

  function strategyLabeledInputs(container) {
    const labels = $$("label", container).filter(l =>
      l.querySelector("input[type=radio],input[type=checkbox]")
    );
    if (labels.length < 2) return null;
    return labels.map(label => {
      const parsed = stripLetterPrefix(textOf(label));
      return { letter: parsed.letter, text: parsed.text, el: label, selected: isSelected(label) };
    });
  }

  function strategyGenericList(container) {
    const items = $$("li, .option, .option-item, .answer-item, .item-option", container).filter(el => {
      if (el.closest(".el-checkbox-group")) return false;
      return /^[A-Za-z](?:[.．、:：]|\s)/.test(textOf(el)) || /^(正确|错误|对|错)/.test(textOf(el));
    });
    if (items.length < 2) return null;
    return items.map((el, i) => {
      const parsed = stripLetterPrefix(textOf(el));
      let letter = parsed.letter;
      if (!letter) {
        if (/^(正确|对|TRUE)/i.test(parsed.text)) letter = "A";
        else if (/^(错误|不正确|错|FALSE)/i.test(parsed.text)) letter = "B";
        else letter = String.fromCharCode(65 + i);
      }
      return { letter, text: parsed.text, el, selected: isSelected(el) };
    });
  }

  function validOptions(list) {
    if (!Array.isArray(list) || list.length < 2 || list.length > 12) return null;
    const cleaned = list.filter(o => o.letter && o.text && o.el);
    if (cleaned.length !== list.length) return null;
    const letters = cleaned.map(o => o.letter);
    if (new Set(letters).size !== letters.length) return null;
    for (let i = 0; i < letters.length; i++) {
      if (letters[i] !== String.fromCharCode(65 + i)) return null;
    }
    return cleaned;
  }

  function extractOptions(container) {
    const strategies = [
      strategyRadioView,
      strategyCheckbox,
      strategyLabeledInputs,
      strategyGenericList
    ];
    for (const strategy of strategies) {
      try {
        const opts = validOptions(strategy(container));
        if (opts) return opts;
      } catch (e) {
        // fall through to the next strategy
      }
    }
    return [];
  }

  const QUESTION_SELECTORS = [
    ".questionName .centent-pre pre",
    ".questionName pre",
    ".questionName",
    ".question-title",
    ".qtContent",
    ".stem",
    ".topic-content",
    ".subject-item",
    ".item-content"
  ];

  function extractQuestionText(container, options) {
    for (const sel of QUESTION_SELECTORS) {
      const el = container.querySelector(sel);
      const t = el ? textOf(el) : "";
      if (t) return t;
    }
    // Fallback: full container text minus the option texts and labels.
    let text = textOf(container);
    for (const o of options) {
      if (o.text) text = text.split(o.text).join(" ");
    }
    text = text
      .replace(/\d+\s*[.、．]\s*/g, " ")
      .replace(/单选题|多选题|判断题/g, " ")
      .replace(/(?:^|\s)[A-Z](?=\s|$)/g, " ");
    return text.replace(/\s+/g, " ").trim();
  }

  function extractQuestion() {
    const container = questionContainer();
    if (!container) {
      return { question: "", rawType: "", type: "unknown", options: [], signature: "" };
    }
    const options = extractOptions(container);
    const rawType = textOf($(".questionTitle", container)) || "";
    const type = detectType(rawType || textOf(container), container);
    const question = extractQuestionText(container, options);
    const signature = JSON.stringify({
      question,
      type,
      options: options.map(({ letter, text }) => ({ letter, text }))
    });
    return { question, rawType, type, options, signature };
  }

  function findNextButton() {
    return (
      $$(".pre-next .next-topic").find(el => textOf(el).includes("下一题")) ||
      $$("button, a, .btn").find(el => textOf(el) === "下一题") ||
      null
    );
  }

  function nextAvailable(button) {
    if (!button) return false;
    const style = getComputedStyle(button);
    const visible =
      button.getClientRects().length > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
    const disabled =
      button.classList.contains("noNext") ||
      button.getAttribute("aria-disabled") === "true" ||
      button.hasAttribute("disabled") ||
      button.disabled === true;
    return visible && !disabled;
  }

  // Innermost visible element whose text is the submit label; avoids picking a wrapper div.
  function findTextButton(predicate) {
    const candidates = $$("button, a, [role=button], .btn, .el-button, span, div").filter(el => {
      const t = textOf(el);
      return predicate(t) && t.length <= 12 && el.getClientRects().length > 0;
    });
    candidates.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    return candidates[0] || null;
  }

  function findSubmitButton() {
    return findTextButton(t => t.includes("提交作业") || t === "提交");
  }

  function findDialogConfirmButton() {
    return findTextButton(t => ["确定", "确 定", "确认", "提交", "仍然提交"].includes(t));
  }

  // ---------- ai ----------

  function buildPrompt(data) {
    return [
      "你是在线课程答题助手，请直接作答。",
      "题型: " + (data.type === "unknown" ? "未知，请根据题干判断单选/多选/判断" : data.type),
      "题目: " + data.question,
      "选项:",
      ...data.options.map(o => o.letter + ". " + o.text),
      "",
      "只返回一个 JSON 对象，不要 Markdown 代码块：",
      '{"type":"single_choice|multiple_choice|true_false","answers":["A"],"confidence":"high|medium|low","explanation":"简要理由"}',
      "answers 永远是数组，元素只能是给出的选项字母。",
      "单选和判断题只返回一个字母；多选题返回所有正确选项字母。",
      "判断题若选项是 正确/错误，正确返回 A，错误返回 B。",
      "不确定时降低 confidence 并在 explanation 里说明原因。"
    ].join("\n");
  }

  function askAI(data) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(new Error("请先在面板填写 API Key 并保存"));
    }
    const body = JSON.stringify({
      model: getModel(),
      temperature: 0,
      messages: [
        { role: "system", content: "你是严谨的答题助手，只输出题目要求的 JSON。" },
        { role: "user", content: buildPrompt(data) }
      ]
    });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: normalizeApiUrl(getBaseUrl()),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        data: body,
        timeout: 60000,
        onload: res => {
          try {
            const json = JSON.parse(res.responseText);
            const content = json?.choices?.[0]?.message?.content;
            if (res.status >= 200 && res.status < 300 && content) {
              resolve(content);
            } else {
              const msg = json?.error?.message || res.responseText || "";
              reject(new Error("HTTP " + res.status + ": " + String(msg).slice(0, 200)));
            }
          } catch (e) {
            reject(new Error("接口返回无法解析: " + String(res.responseText).slice(0, 200)));
          }
        },
        onerror: () => reject(new Error("网络错误，请检查 Base URL / 网络")),
        ontimeout: () => reject(new Error("请求超时（60s）"))
      });
    });
  }

  function parseAnswer(raw) {
    let text = String(raw || "").trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) text = fenced[1];
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) text = text.slice(start, end + 1);

    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      obj = null;
    }

    if (!obj) {
      const m = text.match(/(?:answers?|答案)["\s:：]*([A-Za-z、,\s]+)["}]?/i);
      if (m) {
        const letters = m[1].match(/[A-Z]/gi) || [m[1].trim()];
        return { answers: letters, confidence: "", explanation: "" };
      }
      return null;
    }

    let answers = obj.answers ?? obj.answer ?? [];
    if (!Array.isArray(answers)) answers = String(answers).split(/[,，、\s]+/);
    answers = answers.map(a => String(a).trim()).filter(Boolean);
    return {
      answers,
      confidence: String(obj.confidence || "").toLowerCase(),
      explanation: String(obj.explanation || "").trim()
    };
  }

  function normalizeAnswerLetters(rawAnswers, options, type) {
    const valid = new Set(options.map(o => o.letter));
    const joined = rawAnswers.join(" ").toUpperCase();

    const judgeOption = re => options.find(o => re.test(o.text));
    if (/(正确|对|TRUE|√)/.test(joined)) {
      const yes = judgeOption(/^(正确|对)/);
      if (yes && (type === "true_false" || !valid.has("A"))) return [yes.letter];
    }
    if (/(错误|不正确|FALSE|×|错)/.test(joined)) {
      const no = judgeOption(/^(错误|不正确|错)/);
      if (no && (type === "true_false" || !valid.has("B"))) return [no.letter];
    }

    let letters = [];
    for (const part of rawAnswers) {
      const up = String(part).toUpperCase().trim();
      if (valid.has(up)) {
        letters.push(up);
      } else {
        for (const ch of up) {
          if (/[A-Z]/.test(ch) && valid.has(ch)) letters.push(ch);
        }
      }
    }

    if (!letters.length) {
      for (const o of options) {
        if (o.text && rawAnswers.join(" ").includes(o.text)) letters.push(o.letter);
      }
    }

    return [...new Set(letters)].filter(l => valid.has(l));
  }

  // ---------- answering ----------

  async function selectOption(option) {
    if (!option || !option.el) return false;
    if (isSelected(option.el)) return true;
    option.el.scrollIntoView({ block: "center" });
    await sleep(120);

    const candidates = [
      option.el.querySelector("label"),
      option.el.querySelector("input[type=radio],input[type=checkbox]"),
      option.el
    ].filter(Boolean);

    for (const target of candidates) {
      try {
        target.click();
      } catch (e) {
        // try the next candidate
      }
      await sleep(180);
      if (isSelected(option.el)) return true;
    }

    const icon = option.el.querySelector(".el-checkbox__input, .before, .checkIcon, .letterSort");
    if (icon) {
      try {
        icon.click();
      } catch (e) {
        // selection failed
      }
      await sleep(180);
      if (isSelected(option.el)) return true;
    }
    return false;
  }

  async function applyAnswer(data, letters) {
    const wanted =
      data.type === "single_choice" || data.type === "true_false"
        ? letters.slice(0, 1)
        : letters;
    const results = [];
    for (const letter of wanted) {
      const option = data.options.find(o => o.letter === letter);
      if (!option) {
        results.push({ letter, ok: false });
        continue;
      }
      results.push({ letter, ok: await selectOption(option) });
    }
    return results;
  }

  // ---------- main loop ----------

  async function tick(manual = false) {
    syncToggleButton();
    if (busy || (!isRunning() && !manual)) return;

    const data = extractQuestion();
    if (!data.question || data.options.length < 2) return;
    if (!manual && data.signature === lastSignature) return;

    busy = true;
    const myId = ++requestId;
    try {
      if (!getApiKey()) throw new Error("请先在面板填写 API Key 并保存");
      setStatus("running", "正在分析题目…");

      const raw = await askAI(data);
      if (myId !== requestId) return;

      const parsed = parseAnswer(raw);
      if (!parsed) throw new Error("AI 返回内容不是有效 JSON");

      const letters = normalizeAnswerLetters(parsed.answers, data.options, data.type);
      if (!letters.length) {
        throw new Error("无法匹配选项: " + parsed.answers.join(" "));
      }

      const results = await applyAnswer(data, letters);
      const failed = results.filter(r => !r.ok).map(r => r.letter);
      if (failed.length) {
        throw new Error("部分选项点击失败: " + failed.join(","));
      }

      lastSignature = data.signature;
      setAnswerView(letters, parsed);
      setStatus("ok", "已选择 " + letters.join("、"));

      if (getAutoNext() || manual) {
        await sleep(Math.max(300, getDelayMs()));
        if (myId !== requestId) return;
        const btn = findNextButton();
        if (nextAvailable(btn)) {
          btn.click();
          setStatus("running", "已点击下一题");
        } else if (isRunning()) {
          setRunning(false);
          if (getAutoSubmit()) {
            setStatus("running", "已到最后一题，正在提交作业…");
            await sleep(600);
            const submitBtn = findSubmitButton();
            if (submitBtn) {
              submitBtn.click();
              await sleep(1000);
              const confirmBtn = findDialogConfirmButton();
              if (confirmBtn) {
                confirmBtn.click();
                setStatus("ok", "已提交作业");
              } else {
                setStatus("ok", "已点击提交，请在弹窗中确认");
              }
            } else {
              setStatus("idle", "已完成全部题目，未找到提交按钮");
            }
          } else {
            setStatus("idle", "已完成全部题目");
          }
        }
      }
    } catch (err) {
      console.error("[zh-ai]", err);
      setStatus("error", "出错: " + (err?.message || err));
    } finally {
      busy = false;
    }
  }

  // ---------- panel ----------

  function setStatus(state, message) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const el = $(".zh-ai-status", panel);
    if (!el) return;
    el.className = "zh-ai-status" + (state === "ok" ? " ok" : state === "error" ? " error" : "");
    el.textContent = message;
  }

  function setAnswerView(letters, parsed) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const box = $(".zh-ai-answer", panel);
    if (!box) return;
    box.style.display = "block";
    box.textContent = [
      "答案: " + letters.join("、"),
      parsed.confidence ? "置信度: " + parsed.confidence : "",
      parsed.explanation ? "解析: " + parsed.explanation : ""
    ].filter(Boolean).join("\n");
  }

  function syncToggleButton() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const btn = $("#zh-ai-toggle", panel);
    const running = isRunning();
    if (btn) {
      btn.textContent = running ? "停止" : "开始";
      btn.classList.toggle("stop", running);
    }
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    handle.addEventListener("mousedown", e => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      panel.style.left = ox + e.clientX - sx + "px";
      panel.style.top = oy + e.clientY - sy + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  const PANEL_HTML = `
    <style>
      #${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:300px;
        font:12px/1.5 system-ui,sans-serif;color:#e8ecf5;background:#141a26;
        border:1px solid #2a3550;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);overflow:hidden}
      #${PANEL_ID} *{box-sizing:border-box;margin:0;padding:0}
      .zh-ai-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1b2436;
        cursor:move;font-weight:600;user-select:none}
      .zh-ai-dot{width:8px;height:8px;border-radius:50%;background:#5b6b8c;flex:none}
      .zh-ai-dot.on{background:#33d17a}
      .zh-ai-head .zh-ai-collapse{margin-left:auto;background:none;border:0;color:#9fb0d0;cursor:pointer;font-size:14px}
      .zh-ai-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}
      .zh-ai-status{padding:6px 8px;border-radius:8px;background:#202b42;color:#c7d3ea}
      .zh-ai-status.ok{background:#12351f;color:#7ce38b}
      .zh-ai-status.error{background:#3a1a1e;color:#ff9c9c}
      .zh-ai-answer{display:none;max-height:120px;overflow:auto;background:#202b42;border-radius:8px;
        padding:6px 8px;color:#c7d3ea;white-space:pre-wrap}
      .zh-ai-body label{display:flex;flex-direction:column;gap:3px;color:#9fb0d0}
      .zh-ai-body input{height:26px;border-radius:7px;border:1px solid #2a3550;background:#0f1522;
        color:#e8ecf5;padding:0 8px;outline:none}
      .zh-ai-body input:focus{border-color:#4f7cff}
      .zh-ai-body .zh-ai-row{display:flex;gap:8px}
      .zh-ai-body .zh-ai-row label{flex:1}
      .zh-ai-body .zh-ai-chk{flex-direction:row;align-items:center;gap:6px}
      .zh-ai-body .zh-ai-chk input{width:13px;height:13px}
      .zh-ai-actions{display:flex;gap:8px;margin-top:2px}
      .zh-ai-actions button{flex:1;height:28px;border-radius:7px;border:1px solid #2a3550;
        background:#232f4a;color:#dfe7fa;cursor:pointer}
      .zh-ai-actions button:hover{background:#2b3a5e}
      .zh-ai-actions .zh-ai-primary{background:#3d63dd;border-color:#3d63dd;font-weight:600}
      .zh-ai-actions .zh-ai-primary.stop{background:#b3362f;border-color:#b3362f}
    </style>
    <div class="zh-ai-head">
      <span class="zh-ai-dot"></span> AI 答题助手
      <button class="zh-ai-collapse" type="button">—</button>
    </div>
    <div class="zh-ai-body">
      <div class="zh-ai-status">待机</div>
      <div class="zh-ai-answer"></div>
      <label>Base URL<input id="zh-ai-url" placeholder="https://api.deepseek.com"></label>
      <label>API Key<input id="zh-ai-key" type="password" placeholder="sk-..."></label>
      <label class="zh-ai-chk"><input id="zh-ai-showkey" type="checkbox">显示 Key</label>
      <div class="zh-ai-row">
        <label>Model<input id="zh-ai-model"></label>
        <label>翻题延迟(ms)<input id="zh-ai-delay" type="number" min="0" step="100"></label>
      </div>
      <label class="zh-ai-chk"><input id="zh-ai-autonext" type="checkbox">答完自动点下一题</label>
      <label class="zh-ai-chk"><input id="zh-ai-autosubmit" type="checkbox">答完自动点右上角提交作业</label>
      <div class="zh-ai-actions">
        <button id="zh-ai-toggle" class="zh-ai-primary" type="button">开始</button>
        <button id="zh-ai-once" type="button">分析本题</button>
        <button id="zh-ai-save" type="button">保存</button>
      </div>
    </div>
  `;

  function buildPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = PANEL_HTML;
    document.body.appendChild(panel);

    const $p = s => panel.querySelector(s);
    const urlInput = $p("#zh-ai-url");
    const keyInput = $p("#zh-ai-key");
    const modelInput = $p("#zh-ai-model");
    const delayInput = $p("#zh-ai-delay");
    const autoNextInput = $p("#zh-ai-autonext");
    const autoSubmitInput = $p("#zh-ai-autosubmit");
    const showKeyInput = $p("#zh-ai-showkey");

    urlInput.value = getBaseUrl();
    keyInput.value = getApiKey();
    modelInput.value = getModel();
    delayInput.value = String(getDelayMs());
    autoNextInput.checked = getAutoNext();
    autoSubmitInput.checked = getAutoSubmit();

    showKeyInput.addEventListener("change", () => {
      keyInput.type = showKeyInput.checked ? "text" : "password";
    });

    $p("#zh-ai-save").addEventListener("click", () => {
      GM_setValue(KEY_BASE_URL, urlInput.value.trim());
      GM_setValue(KEY_API_KEY, keyInput.value.trim());
      GM_setValue(KEY_MODEL, modelInput.value.trim());
      GM_setValue(KEY_DELAY, Math.max(0, Number(delayInput.value) || 0));
      GM_setValue(KEY_AUTO_NEXT, autoNextInput.checked);
      GM_setValue(KEY_AUTO_SUBMIT, autoSubmitInput.checked);
      setStatus("ok", "设置已保存");
    });

    $p("#zh-ai-toggle").addEventListener("click", () => {
      const next = !isRunning();
      setRunning(next);
      if (next) lastSignature = "";
      syncToggleButton();
      if (next) tick(false);
    });

    $p("#zh-ai-once").addEventListener("click", () => tick(true));

    $p(".zh-ai-collapse").addEventListener("click", () => {
      const body = $p(".zh-ai-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "flex" : "none";
    });

    makeDraggable(panel, $p(".zh-ai-head"));
    syncToggleButton();
  }

  // ---------- init ----------

  function init() {
    if (window.self === window.top) buildPanel();

    let pending = null;
    const observer = new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(() => tick(false), 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => {
      if (window.self === window.top && !document.getElementById(PANEL_ID)) buildPanel();
      tick(false);
    }, 2000);

    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(KEY_RUNNING, () => syncToggleButton());
    }

    tick(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
