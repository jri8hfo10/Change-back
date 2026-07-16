// Dynamic Background extension for SillyTavern
// 유저/AI 메시지 내용을 LLM에게 다시 보여주고, SillyTavern에 이미 등록되어 있는
// 배경 이미지(설정 > 배경 관리 메뉴에서 업로드한 것들) 중 가장 맥락에 어울리는 것을
// AI가 직접 골라서 자동으로 전환합니다. 별도로 파일명을 입력할 필요가 없습니다.

import { getRequestHeaders } from '../../../../script.js';

const MODULE_NAME = 'dynamic_background';
const NONE_TOKEN = 'NONE';

const defaultSettings = Object.freeze({
    enabled: true,
    autoRun: true,
    transitionMs: 1200,
    defaultImage: '',
    extraInstruction: '',
});

let activeLayer = 'a';
let lastAppliedImage = null;
let isBusy = false;
let cachedImageList = []; // SillyTavern에 이미 등록된 배경 파일명 목록 (자동으로 채워짐)

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

// ---------- SillyTavern에 이미 업로드된 배경 목록 가져오기 ----------
// (설정 > 배경 관리 메뉴, 또는 채팅 화면의 배경 아이콘에서 이미지를 올려두면 여기에 자동으로 잡힙니다)

async function fetchAvailableBackgrounds() {
    try {
        const res = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = (data.images || []).map((img) => img.filename).filter(Boolean);
        cachedImageList = list;
        return list;
    } catch (err) {
        console.error(`[${MODULE_NAME}] 배경 목록을 불러오지 못했습니다:`, err);
        return cachedImageList; // 실패 시 이전 캐시라도 유지
    }
}

// ---------- 배경 레이어 (채팅 UI 뒤에 고정되는 전체화면 div 2장으로 크로스페이드) ----------

function createBackgroundLayers() {
    if (document.getElementById('dynbg-container')) return;

    const container = document.createElement('div');
    container.id = 'dynbg-container';

    const layerA = document.createElement('div');
    layerA.id = 'dynbg-layer-a';
    layerA.className = 'dynbg-layer dynbg-active';

    const layerB = document.createElement('div');
    layerB.id = 'dynbg-layer-b';
    layerB.className = 'dynbg-layer';

    container.appendChild(layerA);
    container.appendChild(layerB);
    document.body.prepend(container);
}

function setBackgroundImage(imageFileName) {
    if (!imageFileName) return;

    const settings = getSettings();
    // SillyTavern이 배경 이미지를 서빙하는 기본 경로
    const imagePath = `/backgrounds/${imageFileName}`;

    if (imagePath === lastAppliedImage) return;
    lastAppliedImage = imagePath;

    const currentId = activeLayer === 'a' ? 'dynbg-layer-a' : 'dynbg-layer-b';
    const nextId = activeLayer === 'a' ? 'dynbg-layer-b' : 'dynbg-layer-a';
    const currentEl = document.getElementById(currentId);
    const nextEl = document.getElementById(nextId);
    if (!currentEl || !nextEl) return;

    const transitionMs = Number(settings.transitionMs) || 1200;

    nextEl.style.transition = 'none';
    nextEl.style.backgroundImage = `url("${imagePath}")`;
    nextEl.style.opacity = '0';
    void nextEl.offsetWidth;
    nextEl.style.transition = `opacity ${transitionMs}ms ease-in-out`;
    nextEl.style.opacity = '1';

    currentEl.style.transition = `opacity ${transitionMs}ms ease-in-out`;
    currentEl.style.opacity = '0';

    activeLayer = activeLayer === 'a' ? 'b' : 'a';
}

// ---------- AI 기반 맥락 매칭 ----------

function buildPrompt(text, imageList, extraInstruction) {
    const listStr = imageList.join(', ');
    const extra = extraInstruction ? `\n추가 지침: ${extraInstruction}` : '';
    return [
        '아래는 롤플레잉 채팅에서 방금 새로 올라온 메시지입니다 (유저 또는 캐릭터/AI가 보낸 것일 수 있습니다).',
        '이 장면의 장소, 시간대, 분위기를 고려했을 때, 사용 가능한 배경 이미지 파일 목록 중 가장 어울리는 것을 하나만 고르세요.',
        '파일명 자체가 그 이미지의 내용을 나타내는 라벨입니다 (예: room.png = 실내/방, forest.png = 숲).',
        '적절한 것이 하나도 없다면 반드시 "NONE"을 선택하세요.',
        `사용 가능한 파일 목록: ${listStr}, ${NONE_TOKEN}`,
        extra,
        '',
        `메시지: """${text}"""`,
    ].join('\n');
}

async function classifyBackground(text) {
    const settings = getSettings();
    const imageList = cachedImageList.filter(Boolean);
    if (imageList.length === 0) {
        console.warn(`[${MODULE_NAME}] 등록된 배경 이미지가 없습니다. SillyTavern의 배경 관리 메뉴에서 이미지를 먼저 업로드하세요.`);
        return null;
    }

    const { generateQuietPrompt } = SillyTavern.getContext();
    const quietPrompt = buildPrompt(text, imageList, settings.extraInstruction);

    const jsonSchema = {
        name: 'BackgroundMatch',
        description: '장면에 가장 어울리는 배경 이미지 파일명을 선택합니다.',
        strict: true,
        value: {
            '$schema': 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                filename: {
                    type: 'string',
                    enum: [...imageList, NONE_TOKEN],
                },
            },
            required: ['filename'],
        },
    };

    try {
        const raw = await generateQuietPrompt({ quietPrompt, jsonSchema });
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.filename === 'string') {
            return matchImageFromList(parsed.filename, imageList);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] 구조화된 출력 실패, 일반 텍스트 방식으로 재시도합니다.`, err);
    }

    try {
        const fallbackPrompt = `${quietPrompt}\n\n반드시 파일명 하나 또는 "${NONE_TOKEN}"만, 다른 말 없이 출력하세요.`;
        const raw = await generateQuietPrompt({ quietPrompt: fallbackPrompt });
        return matchImageFromList(raw, imageList);
    } catch (err) {
        console.error(`[${MODULE_NAME}] 배경 매칭용 생성 실패:`, err);
        return null;
    }
}

function matchImageFromList(rawAnswer, imageList) {
    if (!rawAnswer) return null;
    const cleaned = String(rawAnswer).trim().replace(/["'.]/g, '');
    if (!cleaned || cleaned.toUpperCase() === NONE_TOKEN) return null;

    const exact = imageList.find((img) => img.toLowerCase() === cleaned.toLowerCase());
    if (exact) return exact;

    const partial = imageList.find((img) => cleaned.toLowerCase().includes(img.toLowerCase()));
    if (partial) return partial;

    return null;
}

async function applyBackgroundFromText(text) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (isBusy) return;
    isBusy = true;
    try {
        const image = await classifyBackground(text);
        if (image) {
            setBackgroundImage(image);
        } else if (settings.defaultImage) {
            setBackgroundImage(settings.defaultImage);
        }
    } finally {
        isBusy = false;
    }
}

// ---------- 이벤트 핸들러 ----------

function onAnyMessageRendered() {
    const settings = getSettings();
    if (!settings.autoRun) return;
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage || lastMessage.is_system) return;
    applyBackgroundFromText(lastMessage.mes || '');
}

function onChatChanged() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_system) {
            applyBackgroundFromText(msg.mes || '');
            break;
        }
    }
}

function runOnLastMessage() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) {
        toastr?.info('채팅 내역이 없습니다.');
        return;
    }
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_system) {
            applyBackgroundFromText(msg.mes || '');
            return;
        }
    }
    toastr?.info('메시지를 찾지 못했습니다.');
}

// ---------- 설정 UI ----------

function buildSettingsHtml() {
    const settings = getSettings();
    return `
        <div id="dynbg_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>동적 배경 전환 (Dynamic Background)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="dynbg_enabled">
                        <input id="dynbg_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                        <span>확장 활성화</span>
                    </label>

                    <label class="checkbox_label" for="dynbg_autorun">
                        <input id="dynbg_autorun" type="checkbox" ${settings.autoRun ? 'checked' : ''} />
                        <span>메시지마다 자동 실행 (유저/AI 메시지 모두 포함, 매번 추가 LLM 호출 1회 발생)</span>
                    </label>

                    <label for="dynbg_transition">전환 속도 (ms)</label>
                    <input id="dynbg_transition" class="text_pole" type="number" min="0" step="100" value="${settings.transitionMs}" />

                    <label for="dynbg_default_image">매칭 실패(NONE) 시 기본 배경</label>
                    <select id="dynbg_default_image" class="text_pole"></select>

                    <label for="dynbg_extra">추가 지침 (선택, AI에게 전달됨)</label>
                    <textarea id="dynbg_extra" class="text_pole" rows="2" placeholder="예: 애매하면 실내 배경을 우선 선택해줘">${settings.extraInstruction || ''}</textarea>

                    <small class="dynbg-hint" id="dynbg_status_text">배경 목록 불러오는 중...</small>

                    <div class="dynbg-actions">
                        <div id="dynbg_refresh_list" class="menu_button">배경 목록 새로고침</div>
                        <div id="dynbg_test_last" class="menu_button">마지막 메시지로 지금 다시 계산</div>
                    </div>
                    <small class="dynbg-hint">
                        SillyTavern의 배경 관리 메뉴(채팅 화면 상단의 배경 아이콘)에서 이미지를 올려두면
                        자동으로 이 목록에 반영됩니다. 파일명을 직접 입력할 필요가 없습니다.
                    </small>
                </div>
            </div>
        </div>
    `;
}

function populateDefaultImageSelect() {
    const select = document.getElementById('dynbg_default_image');
    if (!select) return;
    const settings = getSettings();
    const current = settings.defaultImage || '';

    select.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(이전 배경 유지)';
    select.appendChild(noneOpt);

    for (const img of cachedImageList) {
        const opt = document.createElement('option');
        opt.value = img;
        opt.textContent = img;
        select.appendChild(opt);
    }
    select.value = current;
}

function updateStatusText() {
    const el = document.getElementById('dynbg_status_text');
    if (!el) return;
    if (cachedImageList.length === 0) {
        el.textContent = '⚠ 등록된 배경 이미지가 없습니다. SillyTavern 배경 관리 메뉴에서 이미지를 먼저 업로드해주세요.';
    } else {
        el.textContent = `현재 ${cachedImageList.length}개의 배경 이미지를 인식했습니다: ${cachedImageList.join(', ')}`;
    }
}

async function refreshAndRender() {
    const statusEl = document.getElementById('dynbg_status_text');
    if (statusEl) statusEl.textContent = '배경 목록 불러오는 중...';
    await fetchAvailableBackgrounds();
    populateDefaultImageSelect();
    updateStatusText();
}

function attachSettingsListeners() {
    document.getElementById('dynbg_enabled')?.addEventListener('change', (e) => {
        getSettings().enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('dynbg_autorun')?.addEventListener('change', (e) => {
        getSettings().autoRun = e.target.checked;
        saveSettings();
    });

    document.getElementById('dynbg_transition')?.addEventListener('change', (e) => {
        getSettings().transitionMs = Number(e.target.value) || 1200;
        saveSettings();
    });

    document.getElementById('dynbg_default_image')?.addEventListener('change', (e) => {
        getSettings().defaultImage = e.target.value;
        saveSettings();
    });

    document.getElementById('dynbg_extra')?.addEventListener('change', (e) => {
        getSettings().extraInstruction = e.target.value;
        saveSettings();
    });

    document.getElementById('dynbg_refresh_list')?.addEventListener('click', () => {
        refreshAndRender();
    });

    document.getElementById('dynbg_test_last')?.addEventListener('click', () => {
        runOnLastMessage();
    });
}

function initSettingsPanel() {
    if (document.getElementById('dynbg_settings')) return;
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', buildSettingsHtml());
    attachSettingsListeners();
    refreshAndRender();
}

// ---------- 초기화 ----------

async function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    getSettings();
    createBackgroundLayers();
    await fetchAvailableBackgrounds();
    initSettingsPanel();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onAnyMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onAnyMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

const { eventSource, event_types } = SillyTavern.getContext();
eventSource.on(event_types.APP_READY, init);
