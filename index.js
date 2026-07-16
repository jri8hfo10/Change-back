// Dynamic Background extension for SillyTavern
// 키워드를 미리 정해두는 대신, AI 메시지 내용을 LLM에게 보여주고
// 등록된 배경 이미지 파일 목록 중 가장 맥락에 어울리는 것을 직접 고르게 합니다.

const MODULE_NAME = 'dynamic_background';
// 이 확장이 설치된 폴더 경로 (backgrounds 하위 폴더에 이미지를 넣어주세요)
const EXTENSION_URL_PATH = 'scripts/extensions/third-party/st-dynamic-background';

const NONE_TOKEN = 'NONE';

const defaultSettings = Object.freeze({
    enabled: true,
    autoRun: true,
    transitionMs: 1200,
    defaultImage: '',
    // 파일명만 등록해두면, 파일명 자체가 AI에게 주는 "라벨"이 됩니다.
    // 예: room.png, forest.png, beach_night.png ...
    images: ['room.png', 'forest.png', 'beach.png', 'night_street.png', 'classroom.png'],
    extraInstruction: '',
});

let activeLayer = 'a';
let lastAppliedImage = null;
let isBusy = false;

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
    const imagePath = `${EXTENSION_URL_PATH}/backgrounds/${imageFileName}`;

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
    const imageList = (settings.images || []).filter(Boolean);
    if (imageList.length === 0) return null;

    const { generateQuietPrompt } = SillyTavern.getContext();
    const quietPrompt = buildPrompt(text, imageList, settings.extraInstruction);

    // 구조화된 출력을 우선 시도 (Chat Completion API에서만 지원됨)
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

    // 폴백: 구조화된 출력을 지원하지 않는 API(Text Completion 등)를 위한 일반 텍스트 방식
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

    // 정확히 일치하는 파일명 우선
    const exact = imageList.find((img) => img.toLowerCase() === cleaned.toLowerCase());
    if (exact) return exact;

    // 응답 안에 파일명이 부분 문자열로 포함된 경우
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
    // 유저 메시지든 AI 메시지든, 방금 화면에 렌더링된 마지막 메시지를 기준으로 판단합니다.
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
    const imagesText = (settings.images || []).join('\n');
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

                    <label for="dynbg_default_image">매칭 실패(NONE) 시 기본 배경 (비워두면 이전 배경 유지)</label>
                    <input id="dynbg_default_image" class="text_pole" type="text" value="${settings.defaultImage || ''}" placeholder="예: default.png" />

                    <label for="dynbg_images">사용 가능한 배경 파일명 목록 (한 줄에 하나씩)</label>
                    <textarea id="dynbg_images" class="text_pole" rows="6" placeholder="room.png&#10;forest.png&#10;beach.png">${imagesText}</textarea>
                    <small class="dynbg-hint">
                        <code>backgrounds/</code> 폴더에 실제로 존재하는 파일명과 정확히 같아야 합니다.<br/>
                        키워드를 따로 정할 필요 없이, AI가 메시지 내용과 이 파일명들을 보고 가장 맥락에 맞는 것을 스스로 고릅니다.
                        (예: "방 안" → room.png)
                    </small>

                    <label for="dynbg_extra">추가 지침 (선택, AI에게 전달됨)</label>
                    <textarea id="dynbg_extra" class="text_pole" rows="2" placeholder="예: 애매하면 실내 배경을 우선 선택해줘">${settings.extraInstruction || ''}</textarea>

                    <div class="dynbg-actions">
                        <div id="dynbg_test_last" class="menu_button">마지막 메시지로 지금 다시 계산</div>
                    </div>
                </div>
            </div>
        </div>
    `;
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
        getSettings().defaultImage = e.target.value.trim();
        saveSettings();
    });

    document.getElementById('dynbg_images')?.addEventListener('change', (e) => {
        const list = e.target.value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        getSettings().images = list;
        saveSettings();
    });

    document.getElementById('dynbg_extra')?.addEventListener('change', (e) => {
        getSettings().extraInstruction = e.target.value;
        saveSettings();
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
}

// ---------- 초기화 ----------

function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    getSettings();
    createBackgroundLayers();
    initSettingsPanel();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onAnyMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onAnyMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

const { eventSource, event_types } = SillyTavern.getContext();
eventSource.on(event_types.APP_READY, init);
