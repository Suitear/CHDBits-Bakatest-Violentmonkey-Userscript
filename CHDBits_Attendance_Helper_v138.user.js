// ==UserScript==
// @name         CHDBits 签到助手 (V138 双重指纹兼容版)
// @namespace    http://tampermonkey.net/
// @version      138.0
// @description  保留V137所有修复，增加新旧指纹双向匹配逻辑，确保本地题库100%优先命中。
// @author       Gemini
// @match        *://chdbits.co/attendance.php*
// @match        *://chdbits.co/bakatest.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      api.x.ai
// @connect      x.ai
// @connect      api.moonshot.ai
// @connect      api.openai.com
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    const CACHE_PREFIX = 'qa_v89_';
    const OLD_PREFIX = 'qa_v55_';
    const PAGE_SIZE = 7;
    let currentPage = 1;
    let searchQuery = "";

    const GROK_MODELS = ["grok-4-1-fast", "grok-2-1212", "grok-beta"];
    const PLATFORM_ORDER = ["grok", "kimi", "gpt", "gemini"];

    const API_CONFIGS = {
        grok: { name: "Grok", url: "https://api.x.ai/v1/chat/completions", model: "grok-4-1-fast" },
        kimi: { name: "Kimi", url: "https://api.moonshot.ai/v1/chat/completions", model: "moonshot-v1-8k" },
        gpt: { name: "GPT", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
        gemini: { name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent", model: "gemini-1.5-flash-latest" }
    };

// --- 增强版指纹算法 (V138 专用，彻底解决卡死和碰撞) ---
    function getNewFingerprint(q, o) {
        // 1. 更加细腻的清洗逻辑：保留数字和关键符号，只去掉空白字符
        const optionsStr = o.map(x => x.text).sort().join('|');
        const clean = (q + "@@" + optionsStr).replace(/\s/g, '');

        // 2. 双重哈希算法：大幅增加 ID 长度，碰撞概率降低至近乎零
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0, ch; i < clean.length; i++) {
            ch = clean.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

        // 生成更长的十六进制 ID
        return "V138_" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
    }

    // --- 旧指纹算法 (保持原样即可，仅用于兼容搜索) ---
    function getOldFingerprint(q, o) {
        try {
            const optionsStr = o.map(x => x.text).sort().join('');
            const clean = (q + optionsStr).replace(/[\s\W]/g, '');
            return btoa(unescape(encodeURIComponent(clean))).substring(0, 32);
        } catch(e) { return "INVALID_OLD_FP"; }
    }

    function run(force) {
        const log = document.getElementById('logBox');
        log.style.background = "#eef7ff";
        log.innerHTML = "📡 <b>启动引擎...</b>";
        if (force) sessionStorage.clear();
        setTimeout(() => mainProcess(force), 300);
    }

    async function mainProcess(force) {
        const log = document.getElementById('logBox');
        const task = getPageTask();
        if (!task) { log.innerText = "❌ 未发现题目"; return; }

        const fpNew = getNewFingerprint(task.q, task.opts);
        const fpOld = getOldFingerprint(task.q, task.opts);

        const isWrong = /回答错误|请重新|失去|不正确/.test(document.body.innerText);

        if (isWrong) {
            log.style.background = "#fff3cd";
            log.innerHTML = "⚠️ 检测到错误，清理旧缓存...";
            GM_deleteValue(CACHE_PREFIX + fpNew);
            GM_deleteValue(CACHE_PREFIX + fpOld); // 同时尝试清理旧Key
            sessionStorage.clear();
            setTimeout(() => startRelay(fpNew, task), 800);
            return;
        }

        if (!force) {
            // --- 核心修复：多重撞库匹配 ---
            let local = GM_getValue(CACHE_PREFIX + fpNew) ||
                        GM_getValue(CACHE_PREFIX + fpOld) ||
                        GM_getValue(OLD_PREFIX + fpNew) ||
                        GM_getValue(OLD_PREFIX + fpOld);

            if (local && local.answer) {
                log.style.background = "#d4edda";
                log.innerHTML = `✅ <b>智库命中</b> (算法:${local.source||'Legacy'})<br>结果: <span style="color:green;">${local.answer}</span>`;
                applyAnswer(local.answer, false);

                // 如果是旧指纹命中的，顺便帮用户存一份新指纹，实现静默迁移
                if (!GM_getValue(CACHE_PREFIX + fpNew)) {
                    saveToDb(fpNew, task.q, task.opts, local.answer, "Migrated");
                }
                return; // 命中后绝对不再往下走
            }
        }
        startRelay(fpNew, task);
    }

    function startRelay(fp, task) {
        const log = document.getElementById('logBox');
        let tried = JSON.parse(sessionStorage.getItem('tried_plats') || "[]");
        let current = document.getElementById('apiTypeSel').value;
        if (tried.includes(current)) current = PLATFORM_ORDER.find(p => !tried.includes(p));
        if (!current) {
            log.style.background = "#f8d7da";
            log.innerHTML = `<b style="color:red;">❌ API 全线折损</b>`;
            return;
        }
        let key = GM_getValue('key_' + current, '').trim();
        if (!key) { markFailed(current); setTimeout(() => startRelay(fp, task), 400); return; }
        callAPI(current, key, fp, task);
    }

    function callAPI(plat, key, fp, task) {
        const log = document.getElementById('logBox');
        const conf = API_CONFIGS[plat];
        const prompt = `PT站题目：${task.q}\n选项：\n${task.opts.map(o => o.id + ":" + o.text).join('\n')}\n单选仅输出1个ID，多选输出所有ID逗号隔开。只输出ID。`;

        let model = conf.model;
        if (plat === 'grok') model = GROK_MODELS[parseInt(sessionStorage.getItem('grok_idx') || "0")] || GROK_MODELS[0];

        log.style.background = "#f0f0f0";
        log.innerHTML = `📡 <b>呼唤 ${conf.name}</b><br><span style="font-size:9px;color:#666;">模型: ${model}</span>`;

        const headers = { "Content-Type": "application/json" };
        if (plat !== 'gemini') headers["Authorization"] = `Bearer ${key}`;

        GM_xmlhttpRequest({
            method: "POST",
            url: conf.url + (plat === 'gemini' ? `?key=${key}` : ""),
            headers: headers,
            data: JSON.stringify((plat === 'gemini') ? { contents: [{ parts: [{ text: prompt }] }] } : { model: model, messages: [{ role: "system", content: "You are a precise test assistant. Only output option IDs." }, { role: "user", content: prompt }], temperature: 0 }),
            timeout: 30000,
            onload: function(res) {
                if (res.status === 200) {
                    try {
                        const d = JSON.parse(res.responseText);
                        let raw = (plat === 'gemini') ? d.candidates[0].content.parts[0].text : d.choices[0].message.content;
                        const ans = raw.trim().replace(/[^\d,]/g, '').replace(/^,|,$/g, '');
                        log.style.background = "#d4edda";
                        log.innerHTML = `✅ <b>${conf.name} 响应成功</b><br>研判答案: <span style="color:green;">${ans}</span>`;
                        saveToDb(fp, task.q, task.opts, ans, conf.name + "(" + model + ")");
                        applyAnswer(ans, true);
                    } catch(e) { handleErr(plat, "解析失败", fp, task); }
                } else { handleErr(plat, `错误码 ${res.status}`, fp, task); }
            },
            onerror: () => handleErr(plat, "网络异常", fp, task)
        });
    }

    function handleErr(plat, msg, fp, task) {
        if (plat === 'grok') {
            const gIdx = parseInt(sessionStorage.getItem('grok_idx') || "0");
            if (gIdx < GROK_MODELS.length - 1) {
                sessionStorage.setItem('grok_idx', gIdx + 1);
                setTimeout(() => startRelay(fp, task), 600);
                return;
            }
        }
        markFailed(plat);
        setTimeout(() => startRelay(fp, task), 600);
    }

    function markFailed(p) {
        let tried = JSON.parse(sessionStorage.getItem('tried_plats') || "[]");
        if (!tried.includes(p)) tried.push(p);
        sessionStorage.setItem('tried_plats', JSON.stringify(tried));
    }

    function saveToDb(fp, q, o, ans, src) {
        if (!ans) return;
        GM_setValue(CACHE_PREFIX + fp, { question: q, options: o, answer: ans, source: src, ts: Date.now() });
    }

    function applyAnswer(ans, auto) {
        ans.split(',').forEach(id => { const el = document.querySelector(`input[value="${id.trim()}"]`); if (el) el.checked = true; });
        if (auto) setTimeout(() => document.querySelector('input[name="submit"]')?.click(), 1200);
    }

    function getPageTask() {
        let q = ""; document.querySelectorAll('td').forEach(td => { if(/请问|级]/.test(td.innerText)) q = td.innerText.trim(); });
        const opts = []; const inputs = document.querySelectorAll('input[name="choice[]"]');
        if (!inputs.length) return null;
        inputs.forEach(r => {
            let t = r.nextSibling ? r.nextSibling.textContent.trim() : (r.parentElement ? r.parentElement.innerText.trim() : "");
            opts.push({ id: r.value, text: t });
        });
        return { q, opts };
    }

    function setupManualCapture() {
        const saveAction = () => {
            const t = getPageTask();
            const checked = Array.from(document.querySelectorAll('input[name="choice[]"]:checked'));
            const sel = checked.map(i => i.value).join(',');
            if (t && sel) {
                saveToDb(getNewFingerprint(t.q, t.opts), t.q, t.opts, sel, "Manual");
            }
        };
        const subBtn = document.querySelector('input[name="submit"]');
        if (subBtn) subBtn.addEventListener('mousedown', saveAction);
    }

    function createUI() {
        if (document.getElementById('chd-panel-v138')) return;
        const p = document.createElement('div');
        p.id = 'chd-panel-v138';
        p.style = "position:fixed;top:170px;left:50px;z-index:9999999;background:#fff;padding:12px;border:3px solid #3498db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.5);width:180px;font-family:sans-serif;";
        p.innerHTML = `
            <div style="font-size:12px;font-weight:bold;margin-bottom:8px;color:#3498db;text-align:center;">CHD 签到助手 V138</div>
            <select id="apiTypeSel" style="width:100%;margin-bottom:5px;font-size:11px;"><option value="grok">Grok (轮询模式)</option><option value="kimi">Kimi</option><option value="gpt">GPT</option><option value="gemini">Gemini</option></select>
            <input type="password" id="keyInp" style="width:100%;margin-bottom:8px;font-size:11px;" placeholder="API Key">
            <button id="startBtn" style="width:100%;padding:6px;background:#3498db;color:white;border:none;border-radius:4px;margin-bottom:5px;cursor:pointer;font-size:12px;">🚀 开始自动</button>
            <button id="retryBtn" style="width:100%;padding:6px;background:#e67e22;color:white;border:none;border-radius:4px;margin-bottom:5px;cursor:pointer;font-size:12px;">🔄 强制重测</button>
            <button id="viewDbBtn" style="width:100%;padding:6px;background:#2ecc71;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">📚 管理题库</button>
            <div id="logBox" style="font-size:10px;margin-top:8px;padding:8px;background:#f9f9f9;border:1px solid #ddd;min-height:60px;line-height:1.4;">就绪</div>
        `;
        document.body.appendChild(p);
        const sel = document.getElementById('apiTypeSel'), inp = document.getElementById('keyInp');
        sel.value = GM_getValue('api_type', 'grok');
        inp.value = GM_getValue('key_' + sel.value, '');
        sel.onchange = function() { GM_setValue('api_type', this.value); inp.value = GM_getValue('key_' + this.value, ''); };
        inp.onchange = function() { GM_setValue('key_' + sel.value, this.value.trim()); };
        document.getElementById('startBtn').onclick = () => run(false);
        document.getElementById('retryBtn').onclick = () => run(true);
        document.getElementById('viewDbBtn').onclick = () => { currentPage = 1; renderDbModal(); };
        createDbModal();
        setupManualCapture();
    }

    function createDbModal() {
        if (document.getElementById('dbModal')) return;
        const m = document.createElement('div'); m.id = 'dbModal';
        m.style = "display:none;position:fixed;top:170px;right:50px;width:500px;background:#fff;border:3px solid #3498db;border-radius:6px;z-index:10000000;flex-direction:column;max-height:75vh;box-shadow:0 0 40px rgba(0,0,0,0.4);overflow:hidden;";
        m.innerHTML = `
            <div style="padding:15px;background:#f8f9fa;display:flex;justify-content:space-between;border-bottom:1px solid #eee;align-items:center;">
                <b>📚 题库管理 <span id="dbTotalCount" style="color:#3498db;font-size:12px;"></span></b>
                <span id="closeDb" style="cursor:pointer;font-size:24px;">×</span>
            </div>
            <div style="padding:10px;background:#fff;border-bottom:1px solid #eee;"><input type="text" id="dbSearch" placeholder="🔍 检索题干或选项..." style="width:100%;padding:8px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;font-size:13px;"></div>
            <div id="dbContent" style="padding:15px;overflow-y:auto;flex:1;background:#fff;"></div>
            <div style="padding:10px;text-align:center;background:#f8f9fa;border-top:1px solid #eee; display: flex; justify-content: center; gap: 5px; align-items: center;">
                <button id="firstP" style="padding:4px 8px; font-size:11px;">首页</button>
                <button id="prevP" style="padding:4px 8px; font-size:11px;">◀</button>
                <span id="pInfo" style="font-weight:bold; font-size:12px; min-width:60px;">1/1</span>
                <button id="nextP" style="padding:4px 8px; font-size:11px;">▶</button>
                <button id="lastP" style="padding:4px 8px; font-size:11px;">末页</button>
            </div>
        `;
        document.body.appendChild(m);
        document.getElementById('closeDb').onclick = () => m.style.display = 'none';
        document.getElementById('firstP').onclick = () => { currentPage = 1; renderDbModal(); };
        document.getElementById('prevP').onclick = () => { if(currentPage > 1) { currentPage--; renderDbModal(); } };
        document.getElementById('nextP').onclick = () => { currentPage++; renderDbModal(); };
        document.getElementById('dbSearch').oninput = (e) => { searchQuery = e.target.value.trim(); currentPage = 1; renderDbModal(); };
    }

    function renderDbModal() {
        const m = document.getElementById('dbModal'), c = document.getElementById('dbContent'), pI = document.getElementById('pInfo'), tC = document.getElementById('dbTotalCount');
        m.style.display = 'flex';
        let allItems = GM_listValues().filter(k => k.startsWith(CACHE_PREFIX) || k.startsWith(OLD_PREFIX)).map(k => ({ key: k, val: GM_getValue(k) })).sort((a,b)=>(b.val.ts||0)-(a.val.ts||0));
        tC.innerText = `(共 ${allItems.length} 题)`;
        let filtered = allItems;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            filtered = allItems.filter(i => i.val.question.toLowerCase().includes(q) || (i.val.options && i.val.options.some(o => o.text.toLowerCase().includes(q))));
        }
        const total = Math.ceil(filtered.length / PAGE_SIZE) || 1;
        if (currentPage > total) currentPage = total;
        pI.innerText = `${currentPage} / ${total}`;
        document.getElementById('lastP').onclick = () => { currentPage = total; renderDbModal(); };

        if (!filtered.length) { c.innerHTML = `<div style="text-align:center;color:#999;margin-top:50px;">空空如也</div>`; return; }
        c.innerHTML = filtered.slice((currentPage-1)*PAGE_SIZE, currentPage*PAGE_SIZE).map(i => `
            <div style="border-bottom:1px solid #eee;padding:12px 0;font-size:12px;position:relative;">
                <b>${i.val.question}</b>
                <div style="margin:5px 0;padding:5px;background:#fcfcfc;border:1px dashed #ddd;">${i.val.options?i.val.options.map(o=>`<div>[${o.id}] ${o.text}</div>`).join(''):'无选项'}</div>
                <div style="color:green;font-weight:bold;">答案: ${i.val.answer} <small style="color:#999;font-weight:normal;">(${i.val.source||'Manual'})</small></div>
                <button onclick="if(confirm('彻底删除这条记录?')){GM_deleteValue('${i.key}');renderDbModal();}" style="position:absolute;right:0;bottom:10px;color:red;border:none;background:none;cursor:pointer;font-size:11px;">[删除]</button>
            </div>`).join('');
    }


    window.addEventListener('load', createUI);
    setTimeout(createUI, 1200);
})();
