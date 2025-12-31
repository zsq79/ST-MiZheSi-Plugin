/**
 * 密折司 (MiZheSi) - Prompt Inspector Plugin
 * 
 * 这是一个从 Amily2号聊天优化助手 提取出来的独立插件。
 * 功能：在发送生成请求前查看和编辑完整的Prompt内容。
 * 
 * 原作者: Wx-2025
 * 插件提取: Assistant
 */

import { eventSource, event_types, main_api, stopGeneration } from '/script.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '/scripts/popup.js';
import { getTokenCountAsync } from '/scripts/tokenizers.js';

// 插件名称（用于路径计算）
const extensionName = 'ST-MiZheSi-Plugin';

// 全局状态导出，供其他插件查询
window.MiZheSi_Global = {
    isEnabled: () => inspectEnabled,
};

const miZheSiPath = `third-party/${extensionName}`;
const STORAGE_KEY = 'mizhesi_enabled';
const MERGE_MODE_KEY = 'mizhesi_merge_mode';
const COMPACT_MODE_KEY = 'mizhesi_compact_mode';

// 版本检查：确保 SillyTavern 支持必要的事件
if (!('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) || !('CHAT_COMPLETION_PROMPT_READY' in event_types)) {
    toastr.error('【密折司】错误：您的SillyTavern版本过旧，缺少必要的事件支持。请更新至最新版本。');
    throw new Error('【密折司】缺少必要的事件支持。');
}

let inspectEnabled = false;
let mergeMode = true;  // 默认开启合并模式
let compactMode = false;

/**
 * 从 localStorage 加载保存的状态
 */
function loadSavedState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
        inspectEnabled = saved === 'true';
    }
    const savedMerge = localStorage.getItem(MERGE_MODE_KEY);
    if (savedMerge !== null) {
        mergeMode = savedMerge === 'true';
    }
    const savedCompact = localStorage.getItem(COMPACT_MODE_KEY);
    if (savedCompact !== null) {
        compactMode = savedCompact === 'true';
    }
}

/**
 * 添加启动按钮到扩展菜单
 */
function addLaunchButton() {
    const enabledText = '关闭密折司';
    const disabledText = '开启密折司';
    const iconClass = 'fa-solid fa-scroll';

    const getText = () => inspectEnabled ? enabledText : disabledText;

    const launchButton = document.createElement('div');
    launchButton.id = 'miZheSiLaunchButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = '切换【密折司】状态 - Prompt检查器';
    
    const icon = document.createElement('i');
    icon.className = iconClass;
    launchButton.appendChild(icon);

    const textSpan = document.createElement('span');
    textSpan.textContent = getText();
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        console.error('【密折司】无法找到左下角扩展菜单 (extensionsMenu)。');
        return;
    }

    if (document.getElementById(launchButton.id)) {
        return;
    }

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', () => {
        toggleInspectNext();
        textSpan.textContent = getText();
        launchButton.classList.toggle('active', inspectEnabled);
    });

    // 初始化按钮状态
    launchButton.classList.toggle('active', inspectEnabled);
}

/**
 * 切换检查状态
 */
function toggleInspectNext() {
    inspectEnabled = !inspectEnabled;
    toastr.info(`【密折司】已${inspectEnabled ? '开启' : '关闭'}`);
    localStorage.setItem(STORAGE_KEY, String(inspectEnabled));
}

/**
 * 合并连续的同类消息
 * @param {Array} chat - 原始消息数组
 * @returns {Array} - 合并后的消息组
 */
function mergeConsecutiveMessages(chat) {
    const groups = [];
    let currentGroup = null;

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        
        if (currentGroup && currentGroup.role === message.role) {
            // 同类消息，加入当前组
            currentGroup.messages.push({ ...message, originalIndex: i });
        } else {
            // 不同类消息，开始新组
            if (currentGroup) {
                groups.push(currentGroup);
            }
            currentGroup = {
                role: message.role,
                messages: [{ ...message, originalIndex: i }]
            };
        }
    }
    
    if (currentGroup) {
        groups.push(currentGroup);
    }
    
    return groups;
}

/**
 * 显示 Prompt 检查器弹窗
 * @param {string} input - 原始 Prompt 内容（字符串或 JSON 格式的聊天数组）
 * @returns {Promise<string>} - 修改后的 Prompt 内容
 */
async function showPromptInspector(input) {
    const template = $(await renderExtensionTemplateAsync(miZheSiPath, 'template'));
    const container = template.find('#mizhesi-editor-container');
    let isJsonMode = false;
    let originalChat = null;

    const titleHeader = template.find('.mizhesi-header h3');
    const charCountDisplay = $('<span id="mizhesi-char-count" style="font-size: 14px; color: #FFD700; margin-left: 15px; font-weight: normal;"></span>');
    titleHeader.append(charCountDisplay);

    // 初始化模式按钮状态
    const mergeBtn = template.find('#mizhesi-merge-btn');
    const compactBtn = template.find('#mizhesi-compact-btn');
    
    mergeBtn.toggleClass('active', mergeMode);
    compactBtn.toggleClass('active', compactMode);
    if (compactMode) {
        container.addClass('compact');
    }

    /**
     * 更新总字符/Token计数
     */
    const updateTotalCharCount = async () => {
        let totalTokens = 0;
        let totalChars = 0;
        const textareas = template.find('textarea');
        for (const textarea of textareas) {
            const text = $(textarea).val();
            totalTokens += await getTokenCountAsync(text);
            totalChars += text.length;
        }
        charCountDisplay.text(`(总 ${totalTokens} Tokens / ${totalChars} 字)`);
    };

    /**
     * 渲染合并模式的消息
     */
    const renderMergedView = async (chat) => {
        container.empty();
        const groups = mergeConsecutiveMessages(chat);
        
        for (const group of groups) {
            if (group.messages.length === 1) {
                // 单条消息，直接渲染
                await renderSingleMessage(group.messages[0], group.messages[0].originalIndex);
            } else {
                // 多条消息，渲染为组
                await renderMessageGroup(group);
            }
        }
    };

    /**
     * 渲染单条消息
     */
    const renderSingleMessage = async (message, index) => {
        let content = message.content;
        const iconsHtml = getInjectionIcons(content);
        content = removeInjectionMarkers(content);

        const block = $(`
            <div class="mizhesi-message-block" data-role="${message.role}" data-index="${index}">
                <div class="mizhesi-message-header">
                    ${iconsHtml}
                    <span class="mizhesi-line-char-count" style="font-weight: normal; color: #FFD700;"></span>
                    <span class="mizhesi-role">${message.role}</span>
                </div>
                <div class="mizhesi-message-content">
                    <textarea class="mizhesi-message-textarea">${escapeHtml(content)}</textarea>
                </div>
            </div>
        `);

        const textarea = block.find('textarea');
        const lineCharCountDisplay = block.find('.mizhesi-line-char-count');
        
        const updateLineCharCount = async () => {
            const text = textarea.val();
            const lineTokens = await getTokenCountAsync(text);
            const lineChars = text.length;
            lineCharCountDisplay.text(`(${lineTokens}T / ${lineChars}字)`);
        };

        await updateLineCharCount();
        textarea.on('input', async () => {
            await updateLineCharCount();
            await updateTotalCharCount();
        });

        block.find('.mizhesi-message-header').on('click', function(e) {
            if ($(e.target).closest('.mizhesi-line-char-count, .mizhesi-injection-icons').length) {
                return;
            }
            const content = $(this).siblings('.mizhesi-message-content');
            const parentBlock = $(this).closest('.mizhesi-message-block');
            parentBlock.toggleClass('expanded');
            content.slideToggle('fast');
        });

        container.append(block);
    };

    /**
     * 渲染消息组
     */
    const renderMessageGroup = async (group) => {
        let totalTokens = 0;
        let totalChars = 0;
        
        for (const msg of group.messages) {
            const content = removeInjectionMarkers(msg.content);
            totalTokens += await getTokenCountAsync(content);
            totalChars += content.length;
        }

        const groupBlock = $(`
            <div class="mizhesi-merged-group" data-role="${group.role}">
                <div class="mizhesi-group-header">
                    <span class="mizhesi-count-badge">${group.messages.length}条</span>
                    <span class="mizhesi-line-char-count" style="font-weight: normal; color: #FFD700;">(${totalTokens}T / ${totalChars}字)</span>
                    <span class="mizhesi-role">${group.role}</span>
                </div>
                <div class="mizhesi-group-content"></div>
            </div>
        `);

        const groupContent = groupBlock.find('.mizhesi-group-content');

        for (const message of group.messages) {
            let content = message.content;
            const iconsHtml = getInjectionIcons(content);
            content = removeInjectionMarkers(content);

            const subMessage = $(`
                <div class="mizhesi-sub-message" data-index="${message.originalIndex}">
                    <div class="mizhesi-sub-header">
                        ${iconsHtml}
                        <span class="mizhesi-sub-char-count" style="color: #aaa;"></span>
                    </div>
                    <textarea>${escapeHtml(content)}</textarea>
                </div>
            `);

            const textarea = subMessage.find('textarea');
            const charCountSpan = subMessage.find('.mizhesi-sub-char-count');

            const updateSubCharCount = async () => {
                const text = textarea.val();
                const tokens = await getTokenCountAsync(text);
                charCountSpan.text(`(${tokens}T / ${text.length}字)`);
            };

            await updateSubCharCount();
            textarea.on('input', async () => {
                await updateSubCharCount();
                await updateGroupCharCount();
                await updateTotalCharCount();
            });

            groupContent.append(subMessage);
        }

        const updateGroupCharCount = async () => {
            let totalTokens = 0;
            let totalChars = 0;
            groupContent.find('textarea').each(function() {
                totalChars += $(this).val().length;
            });
            for (const ta of groupContent.find('textarea')) {
                totalTokens += await getTokenCountAsync($(ta).val());
            }
            groupBlock.find('.mizhesi-group-header .mizhesi-line-char-count').text(`(${totalTokens}T / ${totalChars}字)`);
        };

        groupBlock.find('.mizhesi-group-header').on('click', function() {
            groupBlock.toggleClass('expanded');
        });

        container.append(groupBlock);
    };

    /**
     * 渲染普通视图（不合并）
     */
    const renderNormalView = async (chat) => {
        container.empty();
        for (let i = 0; i < chat.length; i++) {
            await renderSingleMessage(chat[i], i);
        }
    };

    /**
     * 获取注入标记的图标HTML
     */
    function getInjectionIcons(content) {
        const injectionMarkers = {
            '%%HANLINYUAN_RAG_NOVEL%%': { icon: 'fa-book-open', title: '翰林院注入 (小说)', color: '#66ccff' },
            '%%HANLINYUAN_RAG_CHAT%%': { icon: 'fa-comments', title: '翰林院注入 (聊天记录)', color: '#66ccff' },
            '%%HANLINYUAN_RAG_LOREBOOK%%': { icon: 'fa-atlas', title: '翰林院注入 (世界书)', color: '#66ccff' },
            '%%HANLINYUAN_RAG_MANUAL%%': { icon: 'fa-pencil-alt', title: '翰林院注入 (手动)', color: '#66ccff' },
            '%%AMILY2_TABLE_INJECTION%%': { icon: 'fa-table-cells', title: '表格系统注入', color: '#99cc33' }
        };

        let iconsHtml = '<span class="mizhesi-injection-icons" style="display: inline-flex; gap: 5px; margin-right: 8px;">';
        for (const marker in injectionMarkers) {
            if (content.includes(marker)) {
                const details = injectionMarkers[marker];
                iconsHtml += `<i class="fa-solid ${details.icon}" title="${details.title}" style="color: ${details.color};"></i>`;
            }
        }
        iconsHtml += '</span>';
        return iconsHtml;
    }

    /**
     * 移除注入标记
     */
    function removeInjectionMarkers(content) {
        const markers = [
            '%%HANLINYUAN_RAG_NOVEL%%',
            '%%HANLINYUAN_RAG_CHAT%%',
            '%%HANLINYUAN_RAG_LOREBOOK%%',
            '%%HANLINYUAN_RAG_MANUAL%%',
            '%%AMILY2_TABLE_INJECTION%%'
        ];
        for (const marker of markers) {
            content = content.replace(marker, '');
        }
        return content;
    }

    /**
     * HTML转义
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 收集编辑后的消息
     */
    const collectEditedMessages = () => {
        const newChat = [];
        
        // 处理单条消息
        container.find('.mizhesi-message-block').each(function() {
            const index = parseInt($(this).data('index'));
            const role = $(this).data('role');
            const content = $(this).find('textarea').val();
            newChat.push({ index, role, content });
        });
        
        // 处理合并组中的消息
        container.find('.mizhesi-merged-group .mizhesi-sub-message').each(function() {
            const index = parseInt($(this).data('index'));
            const role = $(this).closest('.mizhesi-merged-group').data('role');
            const content = $(this).find('textarea').val();
            newChat.push({ index, role, content });
        });
        
        // 按原始索引排序
        newChat.sort((a, b) => a.index - b.index);
        
        return newChat.map(m => ({ role: m.role, content: m.content }));
    };

    try {
        const chat = JSON.parse(input);
        if (Array.isArray(chat)) {
            isJsonMode = true;
            originalChat = chat;
            
            if (mergeMode) {
                await renderMergedView(chat);
            } else {
                await renderNormalView(chat);
            }
        } else {
            throw new Error("Input is not a chat array.");
        }
    } catch (e) {
        isJsonMode = false;
        const textArea = $('<textarea id="mizhesi-plain-text-editor" style="width: 100%; height: 100%; box-sizing: border-box;"></textarea>');
        textArea.val(input);
        container.empty().append(textArea);
        textArea.on('input', async () => await updateTotalCharCount());
    }

    await updateTotalCharCount();

    // 绑定工具栏按钮事件
    mergeBtn.on('click', async () => {
        mergeMode = !mergeMode;
        mergeBtn.toggleClass('active', mergeMode);
        localStorage.setItem(MERGE_MODE_KEY, String(mergeMode));
        
        if (isJsonMode && originalChat) {
            // 先收集当前编辑的内容
            const editedMessages = collectEditedMessages();
            // 更新 originalChat
            for (let i = 0; i < editedMessages.length && i < originalChat.length; i++) {
                originalChat[i].content = editedMessages[i].content;
            }
            // 重新渲染
            if (mergeMode) {
                await renderMergedView(originalChat);
            } else {
                await renderNormalView(originalChat);
            }
            await updateTotalCharCount();
        }
    });

    compactBtn.on('click', () => {
        compactMode = !compactMode;
        compactBtn.toggleClass('active', compactMode);
        container.toggleClass('compact', compactMode);
        localStorage.setItem(COMPACT_MODE_KEY, String(compactMode));
    });

    template.find('#mizhesi-expand-all-btn').on('click', () => {
        container.find('.mizhesi-message-block, .mizhesi-merged-group').addClass('expanded');
        container.find('.mizhesi-message-content').slideDown('fast');
    });

    template.find('#mizhesi-collapse-all-btn').on('click', () => {
        container.find('.mizhesi-message-block, .mizhesi-merged-group').removeClass('expanded');
        container.find('.mizhesi-message-content, .mizhesi-group-content').slideUp('fast');
    });

    // 搜索功能
    const searchInput = template.find('#mizhesi-search-input');
    const searchButton = template.find('#mizhesi-search-button');
    const clearButton = template.find('#mizhesi-clear-button');

    const performSearch = () => {
        const searchTerm = searchInput.val().trim();
        if (!searchTerm) return;

        clearHighlights();

        let firstMatch = null;
        const textareas = template.find('textarea');

        textareas.each(function() {
            const textarea = $(this);
            const content = textarea.val();
            const regex = new RegExp(searchTerm.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
            
            if (regex.test(content)) {
                textarea.addClass('mizhesi-highlight-border');
                if (!firstMatch) {
                    firstMatch = textarea;
                }

                // 展开包含匹配的块
                const block = textarea.closest('.mizhesi-message-block, .mizhesi-merged-group');
                if (block.length && !block.hasClass('expanded')) {
                    block.addClass('expanded');
                    block.find('.mizhesi-message-content, .mizhesi-group-content').slideDown('fast');
                }
            }
        });

        if (firstMatch) {
            firstMatch[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            toastr.info('【密折司】未找到匹配项。');
        }
    };

    const clearHighlights = () => {
        template.find('.mizhesi-highlight-border').removeClass('mizhesi-highlight-border');
    };

    searchButton.on('click', performSearch);
    searchInput.on('keypress', (e) => {
        if (e.which === 13) {
            performSearch();
        }
    });
    clearButton.on('click', clearHighlights);

    // 自定义按钮：取消生成
    const customButton = {
        text: '取消生成',
        result: POPUP_RESULT.CANCELLED,
        appendAtEnd: true,
        action: async () => {
            await stopGeneration();
            await popup.complete(POPUP_RESULT.CANCELLED);
        },
    };

    const popup = new Popup(template, POPUP_TYPE.CONFIRM, '', { 
        wide: true, 
        large: true, 
        okButton: '确认修改', 
        cancelButton: '放弃修改', 
        customButtons: [customButton] 
    });

    const result = await popup.show();

    if (!result) {
        return input; // 用户取消，返回原始输入
    }

    if (isJsonMode) {
        const newChat = collectEditedMessages();
        return JSON.stringify(newChat, null, 4);
    } else {
        return template.find('#mizhesi-plain-text-editor').val();
    }
}

/**
 * 判断当前是否使用 Chat Completion API
 */
function isChatCompletion() {
    return main_api === 'openai';
}

// 注册事件监听器：Text Generation API
eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, async (data) => {
    if (!inspectEnabled || data.dryRun || isChatCompletion()) return;
    if (typeof data.prompt !== 'string') return;

    const result = await showPromptInspector(data.prompt);
    if (result !== data.prompt) {
        data.prompt = result;
        console.log('【密折司】奏章已按御笔修改 (Text Gen)。');
    }
});

// 注册事件监听器：Chat Completion API
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (!inspectEnabled || data.dryRun || !isChatCompletion()) return;
    if (!Array.isArray(data.chat)) return;

    const originalJson = JSON.stringify(data.chat, null, 4);
    const resultJson = await showPromptInspector(originalJson);

    if (resultJson === originalJson) return;

    try {
        const modifiedChat = JSON.parse(resultJson);
        data.chat.splice(0, data.chat.length, ...modifiedChat);
        console.log('【密折司】奏章已按御笔修改 (Chat Completion)。');
    } catch (e) {
        console.error('【密折司】解析修改后的JSON奏章失败:', e);
        toastr.error('【密折司】解析JSON失败，本次修改未生效。');
    }
});

// 初始化
loadSavedState();
addLaunchButton();

console.log('【密折司】Prompt检查器插件已加载完成。');
