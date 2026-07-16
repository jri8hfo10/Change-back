// Dynamic Background extension for SillyTavern
// AI가 출력한 메시지 내용에서 키워드를 찾아 로컬 이미지 폴더의 배경으로 전환합니다.

const MODULE_NAME = 'dynamic_background';
// 이 확장이 설치된 폴더 경로 (backgrounds 하위 폴더에 이미지를 넣어주세요)
// third-party 폴더에 설치했다면 그대로 두면 되고, 다른 이름으로 설치했다면 아래 값을 수정하세요.
const EXTENSION_URL_PATH = 'scripts/extensions/third-party/st-dynamic-background';

const defaultSettings = Object.freeze({
    enabled: true,
    transitionMs: 1200,
    defaultImage: '',
    rules: [
        { keywords: '숲, 나무, forest', image: 'forest.jpg' },
        { keywords: '바다, 해변, ocean, beach', image: 'beach.jpg' },
        { keywords: '밤, 어두운, night', image: 'night.jpg' },
        { keywords: '교실, 학교, classroom, school', image: 'classroom.jpg' },
    ],
});

let activeLayer = 'a';
let lastAppliedImage = null;

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

    // 같은 이미지면 다시 전환하지 않음
    if (imagePath === lastAppliedImage) return;
    lastAppliedImage = imagePath;

    const currentId = activeLayer === 'a' ? 'dynbg-layer-a' : 'dynbg-layer-b';
    const nextId = activeLayer === 'a' ? 'dynbg-layer-b' : 'dynbg-layer-a';
    const currentEl = document.getElementById(currentId);
    const nextEl = document.getElementById(nextId);
    if (!currentEl || !nextEl) return;

    const transitionMs = Number(settings.transitionMs) || 1200;

    // 다음 레이어에 새 이미지를 먼저 세팅 (트랜지션 없이)
    nextEl.style.transition = 'none';
    nextEl.style.backgroundImage = `url("${imagePath}")`;
    nextEl.style.opacity = '0';
    // 강제 리플로우 후 트랜지션 적용
    void nextEl.offsetWidth;
    nextEl.style.transition = `opacity ${transitionMs}ms ease-in-out`;
    nextEl.style.opacity = '1';

    currentEl.style.transition = `opacity ${transitionMs}ms ease-in-out`;
    currentEl.style.opacity = '0';

    activeLayer = activeLayer === 'a' ? 'b' : 'a';
}

// ---------- 키워드 매칭 ----------

function findMatchingImage(text) {
    const settings = getSettings();
    if (!text) return settings.defaultImage || null;
    const lowerText = text.toLowerCase();

    for (const rule of settings.rules) {
        if (!rule.image) continue;
        const keywords = (rule.keywords || '')
            .split(',')
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);

        for (const kw of keywords) {
            if (lowerText.includes(kw)) {
                return rule.image;
            }
        }
    }
    return settings.defaultImage || null;
}

function applyBackgroundFromText(text) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const image = findMatchingImage(text);
    if (image) {
        setBackgroundImage(image);
    }
}

// ---------- 이벤트 핸들러 ----------

function onCharacterMessageRendered() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return;
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage || lastMessage.is_user || lastMessage.is_system) return;
    applyBackgroundFromText(lastMessage.mes || '');
}

function onChatChanged() {
    // 채팅을 바꿨을 때, 마지막 AI 메시지를 기준으로 배경을 다시 맞춤
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user && !msg.is_system) {
            applyBackgroundFromText(msg.mes || '');
            break;
        }
    }
}

// ---------- 설정 UI ----------

function buildRuleRowHtml(rule, index) {
    const keywords = rule.keywords ? String(rule.keywords).replace(/"/g, '&quot;') : '';
    const image = rule.image ? String(rule.image).replace(/"/g, '&quot;') : '';
    return `
        <div class="dynbg-rule-row" data-index="${index}">
            <input type="text" class="text_pole dynbg-keywords-input" placeholder="키워드 (쉼표로 구분)" value="${keywords}" />
            <input type="text" class="text_pole dynbg-image-input" placeholder="이미지 파일명 (예: forest.jpg)" value="${image}" />
            <div class="dynbg-remove-btn menu_button" title="삭제">✕</div>
        </div>
    `;
}

function renderRuleRows() {
    const settings = getSettings();
    const container = document.getElementById('dynbg_rules_container');
    if (!container) return;
    container.innerHTML = settings.rules.map((rule, i) => buildRuleRowHtml(rule, i)).join('');

    container.querySelectorAll('.dynbg-remove-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const row = e.target.closest('.dynbg-rule-row');
            const index = Number(row.dataset.index);
            const s = getSettings();
            s.rules.splice(index, 1);
            saveSettings();
            renderRuleRows();
        });
    });

    container.querySelectorAll('.dynbg-keywords-input').forEach((input, i) => {
        input.addEventListener('change', () => {
            const s = getSettings();
            s.rules[i].keywords = input.value;
            saveSettings();
        });
    });

    container.querySelectorAll('.dynbg-image-input').forEach((input, i) => {
        input.addEventListener('change', () => {
            const s = getSettings();
            s.rules[i].image = input.value;
            saveSettings();
        });
    });
}

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

                    <label for="dynbg_transition">전환 속도 (ms)</label>
                    <input id="dynbg_transition" class="text_pole" type="number" min="0" step="100" value="${settings.transitionMs}" />

                    <label for="dynbg_default_image">기본 배경 이미지 파일명 (매칭 실패 시, 비워두면 유지)</label>
                    <input id="dynbg_default_image" class="text_pole" type="text" value="${settings.defaultImage || ''}" placeholder="예: default.jpg" />

                    <small class="dynbg-hint">
                        이미지는 확장 폴더의 <code>backgrounds/</code> 하위에 넣어주세요.<br/>
                        AI 메시지에 아래 키워드 중 하나라도 포함되면(대소문자 무관), 위에서부터 순서대로 첫 매칭 규칙의 이미지로 전환됩니다.
                    </small>

                    <div class="dynbg-row-label">
                        <span>키워드 (쉼표로 구분)</span>
                        <span>이미지 파일명</span>
                    </div>
                    <div id="dynbg_rules_container"></div>

                    <div class="dynbg-actions">
                        <div id="dynbg_add_rule" class="menu_button">+ 규칙 추가</div>
                        <div id="dynbg_test_last" class="menu_button">마지막 메시지로 테스트</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function attachSettingsListeners() {
    const enabledEl = document.getElementById('dynbg_enabled');
    enabledEl?.addEventListener('change', () => {
        getSettings().enabled = enabledEl.checked;
        saveSettings();
    });

    const transitionEl = document.getElementById('dynbg_transition');
    transitionEl?.addEventListener('change', () => {
        getSettings().transitionMs = Number(transitionEl.value) || 1200;
        saveSettings();
    });

    const defaultImageEl = document.getElementById('dynbg_default_image');
    defaultImageEl?.addEventListener('change', () => {
        getSettings().defaultImage = defaultImageEl.value.trim();
        saveSettings();
    });

    document.getElementById('dynbg_add_rule')?.addEventListener('click', () => {
        const s = getSettings();
        s.rules.push({ keywords: '', image: '' });
        saveSettings();
        renderRuleRows();
    });

    document.getElementById('dynbg_test_last')?.addEventListener('click', () => {
        onCharacterMessageRendered();
    });

    renderRuleRows();
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

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

// APP_READY 이후에 실행되도록 등록 (이미 준비된 상태면 즉시 실행됨)
const { eventSource, event_types } = SillyTavern.getContext();
eventSource.on(event_types.APP_READY, init);
