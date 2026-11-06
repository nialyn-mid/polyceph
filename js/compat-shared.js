/**
 * compat-shared.js
 * Shared compatibility utilities for reading SillyTavern's active settings.
 * Covers stopping strings, token counting, and context limits that apply
 * regardless of whether Chat Completion or Text Completion API is in use.
 *
 * IMPORTANT DESIGN NOTE:
 * SillyTavern's generateRaw() internally calls createGenerationParameters() (Chat)
 * or getTextGenGenerationData() (Text), which already apply ALL sampler settings
 * (temperature, top_p, penalties, logit bias, banned tokens, etc.) from the active
 * preset. Polyceph does NOT need to replicate that logic.
 *
 * This module only provides utilities that Polyceph needs for its OWN decisions:
 *   1. Token budgeting — to warn or truncate before sending.
 *   2. Stopping string post-processing — to clean leaked stops from output.
 *   3. Active limits — to pass responseLength overrides to generateRaw.
 *
 * Reference:
 *   getStoppingStrings()             — script.js:L2946
 *   getCustomStoppingStrings()       — power-user.js:L3081
 *   getInstructStoppingSequences()   — instruct-mode.js:L301
 *   getMaxContextTokens()            — script.js:L5840
 *   getMaxResponseTokens()           — script.js:L5877
 *   getMaxPromptTokens()             — script.js:L5892
 *   createGenerationParameters()     — openai.js:L2529  (Chat: auto-applied by ST)
 *   getTextGenGenerationData()       — textgen-settings.js:L1842 (Text: auto-applied by ST)
 *   createTextGenGenerationData()    — textgen-settings.js:L1586 (Text: actual param builder)
 */

import { MODULE_NAME } from './constants.js';
import { logger } from './logger.js';
import { getWorldInfoModule, getOpenAIModule, getTextGenModelsModule, getTextGenSettingsModule, getSSEModule, getScriptModule } from './compat-st.js';

// ---------------------------------------------------------------------------
// Stopping Strings
// ---------------------------------------------------------------------------

/**
 * Retrieves the effective stopping strings from SillyTavern's active settings.
 * Mirrors the logic of getStoppingStrings() in script.js:L2946.
 *
 * For Chat Completion (openai): only custom stopping strings apply.
 * For Text Completion: custom + instruct sequence + name-based stops.
 *
 * @returns {string[]} Array of unique, non-empty stopping strings.
 */
export function getEffectiveStoppingStrings() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi;
    const powerUser = ctx.powerUserSettings;

    // Chat Completion only uses custom stopping strings (script.js:L2948-2949)
    if (api === 'openai') {
        return getCustomStoppingStrings(powerUser);
    }

    const result = [];

    // 1. Name-based stopping strings (script.js:L2954-2977)
    if (powerUser?.context?.names_as_stop_strings) {
        const charString = `\n${ctx.name2}:`;
        const userString = `\n${ctx.name1}:`;
        result.push(userString, charString);
    }

    // 2. Instruct stopping sequences (instruct-mode.js:L301-367)
    result.push(...getInstructStoppingSequences(ctx, powerUser));

    // 3. Custom stopping strings (power-user.js:L3081-3123)
    result.push(...getCustomStoppingStrings(powerUser));

    // 4. Single-line mode
    if (powerUser?.single_line) {
        result.unshift('\n');
    }

    // Deduplicate and filter
    return result.filter(x => x).filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Parses the custom stopping strings from power_user settings.
 * Mirrors power-user.js:L3081-3123.
 *
 * @param {object} powerUser - The power_user settings object.
 * @returns {string[]} Parsed custom stopping strings.
 */
function getCustomStoppingStrings(powerUser) {
    try {
        if (!powerUser?.custom_stopping_strings) return [];

        let strings = JSON.parse(powerUser.custom_stopping_strings);
        if (!Array.isArray(strings)) return [];

        strings = strings.filter(s => typeof s === 'string' && s.length > 0);

        // Macro substitution (power-user.js:L3101-3103)
        if (powerUser.custom_stopping_strings_macro) {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.substituteParams === 'function') {
                strings = strings.map(x => ctx.substituteParams(x));
            }
        }

        return strings;
    } catch (error) {
        logger.warn('Error parsing custom stopping strings:', error);
        return [];
    }
}

/**
 * Extracts instruct-mode stopping sequences.
 * Mirrors instruct-mode.js:L301-367.
 *
 * @param {object} ctx - SillyTavern context.
 * @param {object} powerUser - The power_user settings object.
 * @returns {string[]} Instruct stopping sequences.
 */
function getInstructStoppingSequences(ctx, powerUser) {
    const instruct = powerUser?.instruct;
    if (!instruct || !instruct.enabled) return [];

    const result = [];
    const substituteParams = typeof ctx.substituteParams === 'function' ? ctx.substituteParams : (x => x);

    const addSequence = (sequence) => {
        if (typeof sequence !== 'string' || sequence.trim().length === 0) return;
        const wrapped = instruct.wrap ? '\n' + sequence : sequence;
        const stopString = instruct.macro ? substituteParams(wrapped) : wrapped;
        result.push(stopString);
    };

    const stopSequence = instruct.stop_sequence || '';
    const inputSequence = (instruct.input_sequence || '').replace(/{{name}}/gi, ctx.name1 || '');
    const outputSequence = (instruct.output_sequence || '').replace(/{{name}}/gi, ctx.name2 || '');
    const firstOutputSequence = (instruct.first_output_sequence || '').replace(/{{name}}/gi, ctx.name2 || '');
    const lastOutputSequence = (instruct.last_output_sequence || '').replace(/{{name}}/gi, ctx.name2 || '');
    const systemSequence = (instruct.system_sequence || '').replace(/{{name}}/gi, 'System');
    const lastSystemSequence = (instruct.last_system_sequence || '').replace(/{{name}}/gi, 'System');

    const combined = [stopSequence];

    if (instruct.sequences_as_stop_strings) {
        combined.push(
            inputSequence, outputSequence,
            firstOutputSequence, lastOutputSequence,
            systemSequence, lastSystemSequence,
        );
    }

    combined.join('\n').split('\n')
        .filter((v, i, a) => a.indexOf(v) === i) // onlyUnique
        .forEach(addSequence);

    // Context-level stop strings (chat_start, example_separator)
    if (powerUser?.context?.use_stop_strings) {
        if (powerUser.context.chat_start) {
            result.push(`\n${substituteParams(powerUser.context.chat_start)}`);
        }
        if (powerUser.context.example_separator) {
            result.push(`\n${substituteParams(powerUser.context.example_separator)}`);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Token & Context Limits
// ---------------------------------------------------------------------------

/**
 * Gets the maximum context token limit for the active API.
 * Mirrors script.js:L5840-5871.
 *
 * Reads from the LIVE settings objects (oai_settings / max_context) which
 * reflect the currently selected preset, not defaults.
 *
 * @returns {number} Maximum context tokens.
 */
/**
 * Retrieves the effective context limit from SillyTavern's active settings.
 * Prioritizes backend-reported hard caps and dynamic model metadata over static UI values.
 * 
 * @returns {Promise<number>} Current context limit in tokens.
 */
export async function getMaxContextTokens() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi;
    const oaiSettings = ctx.chatCompletionSettings;
    const powerUser = ctx.powerUserSettings;

    let requestedLimit = 0;
    let modelHardCap = Infinity;

    // 1. OpenAI / OpenRouter (via OpenAI API)
    if (api === 'openai') {
        requestedLimit = Number(oaiSettings?.openai_max_context) || 4096;

        // If context is NOT unlocked, we should try to find the model's hard cap in ST's model list
        const isUnlocked = oaiSettings?.max_context_unlocked || powerUser?.max_context_unlocked;
        if (!isUnlocked) {
            try {
                const openaiModule = await getOpenAIModule();
                const { model_list, getChatCompletionModel } = openaiModule || {};
                const activeModelId = getChatCompletionModel(oaiSettings);
                const model = model_list?.find(m => m.id === activeModelId);

                if (model) {
                    modelHardCap = Number(model.context_length || model.max_context_length || modelHardCap);
                } else {
                    logger.warn(`Model "${activeModelId}" not in model_list; using configured context limit.`);
                }
            } catch (e) {
                logger.warn('Chat Completion model metadata unavailable; using configured context limit:', e);
            }
        } else {
            // Unlocked context (Global Power User or OpenAI specific)
            // We set the hard cap to Infinity to allow the user's requestedLimit (slider) to be the sole constraint.
            modelHardCap = Infinity;
        }
    }
    // 2. Text Completion (Kobold, Ooba, OpenRouter-Text, etc.)
    else if (api === 'kobold' || api === 'koboldhorde' || api === 'textgenerationwebui') {
        requestedLimit = Number(ctx.maxContext) || 2048;

        const isUnlocked = powerUser?.max_context_unlocked;

        // For TextGen, check if it's OpenRouter which provides model-specific caps
        if (api === 'textgenerationwebui' && !isUnlocked) {
            try {
                const tgSettingsModule = await getTextGenSettingsModule();
                const { textgenerationwebui_settings } = tgSettingsModule || {};
                if (textgenerationwebui_settings?.type === 'openrouter') {
                    const tgModelsModule = await getTextGenModelsModule();
                    const { openRouterModels } = tgModelsModule || {};
                    const activeModelId = textgenerationwebui_settings.openrouter_model;
                    const model = openRouterModels?.find(m => m.id === activeModelId);

                    if (model) {
                        modelHardCap = Number(model.context_length || modelHardCap);
                    } else {
                        logger.warn(`OpenRouter model "${activeModelId}" not in model list; using configured context limit.`);
                    }
                }
            } catch (e) {
                logger.warn('Text Completion model metadata unavailable; using configured context limit:', e);
            }
        } else if (isUnlocked) {
            modelHardCap = Infinity;
        }
    }
    // 3. NovelAI
    else if (api === 'novel') {
        requestedLimit = Number(ctx.maxContext) || 2048;
        const model = ctx.novelAISettings?.model_novel || '';
        // Mirroring ST core hard caps for NAI models
        if (model.includes('clio') || model.includes('kayra') || model.includes('erato')) {
            modelHardCap = 8192;
        }
    }

    // 4. Secondary Check: UI Element (as a fallback or override)
    const counterId = api === 'openai' ? 'openai_max_context_counter' : 'max_context_counter';
    const counterEl = document.getElementById(counterId);
    if (counterEl) {
        const uiValue = parseInt(counterEl.value || counterEl.innerText);
        if (!isNaN(uiValue) && uiValue > 0) {
            modelHardCap = Math.min(modelHardCap, uiValue);
        }
    }

    // Missing model metadata is OK when a configured context limit is available.
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
        const errorMsg = `Unable to determine reliable context limit for API: ${api}. Aborting for safety.`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    return Math.min(requestedLimit, modelHardCap);
}

/**
 * Retrieves the maximum number of tokens reserved for the LLM's response.
 * Follows SillyTavern's internal logic for different API types.
 * 
 * @returns {number} Maximum response tokens.
 */
export function getMaxResponseTokens() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi;

    if (api === 'openai') {
        const val = Number(ctx.chatCompletionSettings?.openai_max_tokens);
        if (!isNaN(val) && val > 0) return val;
    }

    if (api === 'kobold' || api === 'koboldhorde' || api === 'textgenerationwebui' || api === 'novel') {
        const amountGenEl = document.getElementById('amount_gen');
        if (amountGenEl) {
            const val = Number(amountGenEl.value);
            if (!isNaN(val) && val > 0) return val;
        }

        const val = Number(ctx.textCompletionSettings?.max_new_tokens);
        if (!isNaN(val) && val > 0) return val;
    }

    const errorMsg = `Unable to determine response token reservation for API: ${api}.`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
}

/**
 * Gets the maximum usable prompt token size (context minus response reservation).
 * Mirrors script.js:L5892-5898.
 *
 * @param {number} [overrideResponseLength] Optional override for response length.
 * @returns {Promise<number>} Maximum prompt tokens.
 */
export async function getMaxPromptTokens(overrideResponseLength = null) {
    const responseTokens = (typeof overrideResponseLength === 'number' && overrideResponseLength > 0)
        ? overrideResponseLength
        : getMaxResponseTokens();

    const contextTokens = await getMaxContextTokens();
    return contextTokens - responseTokens;
}

/**
 * Counts the number of tokens in a given text or message array using ST's tokenizer.
 *
 * @param {string | object[]} content - Text string or array of {role, content} messages.
 * @returns {Promise<number>} Token count.
 */
export async function countTokens(content) {
    const ctx = SillyTavern.getContext();

    if (typeof ctx.getTokenCountAsync === 'function') {
        if (typeof content === 'string') {
            return await ctx.getTokenCountAsync(content);
        }
        // For message arrays, count the combined content
        const text = content.map(m => m.content || '').join('\n');
        return await ctx.getTokenCountAsync(text);
    }

    const errorMsg = 'SillyTavern tokenizer (getTokenCountAsync) is not available. Token counting failed.';
    logger.error(errorMsg);
    throw new Error(errorMsg);
}

// ---------------------------------------------------------------------------
// Active API Detection
// ---------------------------------------------------------------------------

/**
 * Returns the active API type string ('openai', 'textgenerationwebui', 'kobold', 'novel').
 * @returns {string} The active main API.
 */
export function getActiveApi() {
    return SillyTavern.getContext().mainApi || 'openai';
}

// ---------------------------------------------------------------------------
// Context & Profile Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat Message Helpers
// ---------------------------------------------------------------------------

/**
 * Posts a message to SillyTavern's chat, handling addOneMessage, saveChat, and event emission.
 *
 * @param {object} options
 * @param {string} options.content - The message text.
 * @param {string} [options.name='Assistant'] - Display name for the message.
 * @param {boolean} [options.isUser=false] - Whether this is a user message.
 * @param {string} [options.forceAvatar=''] - Avatar URL override.
 * @param {object} [options.extra={}] - Extra metadata to attach.
 * @param {boolean} [options.save=true] - Whether to call saveChat after posting.
 * @returns {number} The index of the posted message in the chat array.
 */
/**
 * Normalizes API names for SillyTavern icons.
 * e.g., 'openrouter-text' -> 'openrouter'
 */
function normalizeApiForIcon(api) {
    if (!api) return '';
    const normalized = api.toLowerCase();

    // Standard mappings for multi-mode APIs and aliases
    if (normalized.startsWith('openrouter')) return 'openrouter';
    if (normalized.startsWith('openai')) return 'openai';
    if (normalized.startsWith('kobold')) return 'kobold';
    if (normalized === 'google') return 'makersuite';
    if (normalized === 'makersuite') return 'makersuite';
    if (normalized === 'horde') return 'koboldhorde';

    return normalized;
}

/**
 * Posts a message to SillyTavern's chat, handling addOneMessage, saveChat, and event emission.
 *
 * @param {object} options
 * @param {string} options.content - The message text.
 * @param {string} [options.name='Assistant'] - Display name for the message.
 * @param {boolean} [options.isUser=false] - Whether this is a user message.
 * @param {string} [options.forceAvatar=''] - Avatar URL override.
 * @param {object} [options.extra={}] - Extra metadata to attach.
 * @param {boolean} [options.save=true] - Whether to call saveChat after posting.
 * @param {string} [options.api=''] - The API provider ID (for icons).
 * @param {string} [options.model=''] - The LLM model name (for tooltips).
 * @returns {number} The index of the posted message in the chat array.
 */
import { pollCondition } from './utils.js';

/**
 * Ensures the chat is saved to disk and waits for completion.
 * Critical for preventing 500 errors in extensions that read the chat file.
 */
export async function ensureChatSaved(timeout = 5000) {
    const context = SillyTavern.getContext();

    if (typeof context.saveChat === 'function') {
        logger.debug('ensureChatSaved: Synchronizing chat to disk...');

        // If it's already saving, give it a moment to finish naturally
        if (window.isChatSaving) {
            logger.debug('ensureChatSaved: Save already in progress, waiting...');
            await pollCondition(() => window.isChatSaving === false, 2000);
        }

        // Forcibly clear the flag if it's still stuck (SillyTavern sometimes leaks this flag)
        if (window.isChatSaving) {
            logger.warn('ensureChatSaved: isChatSaving flag stuck! Forcing reset.');
            window.isChatSaving = false;
        }

        try {
            // saveChat returns a promise that resolves when the server confirms the save
            await context.saveChat();
            logger.debug('ensureChatSaved: Chat save confirmed on disk.');
            return true;
        } catch (e) {
            logger.error('ensureChatSaved: Failed to save chat:', e);
            return false;
        }
    }
    return true;
}

export async function postMessageToChat({ content, name = 'Assistant', isUser = false, forceAvatar = '', extra = {}, save = true, api = '', model = '', silent = false }) {
    const ctx = SillyTavern.getContext();
    const isSilentEmulation = ctx.extensionSettings?.polyceph?.emulateCoreEvents;

    const iconApi = normalizeApiForIcon(api || extra.api);

    const msgExtra = {
        ...extra,
        api: iconApi,
        model: model || extra.model,
        polyceph_source: 'polyceph',
        is_silent: silent
    };

    const msg = {
        name: name,
        is_user: isUser,
        is_system: false,
        send_date: typeof ctx.humanizedDateTime === 'function' ? ctx.humanizedDateTime() : new Date().toLocaleString(),
        mes: content,
        extra: msgExtra,
        // Initialize swipes from creation so ST renders swipe UI (counter/arrows) immediately
        swipes: [content],
        swipe_info: [{ extra: { ...msgExtra } }],
        swipe_id: 0,
    };

    if (forceAvatar) {
        msg.force_avatar = forceAvatar;
    }

    ctx.chat.push(msg);
    const messageIndex = ctx.chat.length - 1;

    if (typeof ctx.addOneMessage === 'function') {
        ctx.addOneMessage(msg);
    }

    // Emulate core events if enabled and not silent
    if (!silent && ctx.eventSource && ctx.eventTypes && isSilentEmulation) {
        if (isUser) {
            ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, messageIndex);
            ctx.eventSource.emit(ctx.eventTypes.USER_MESSAGE_RENDERED, messageIndex);
        } else {
            ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, messageIndex);
            ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageIndex);
        }
    }

    // Standard save logic - we skip if silent because the pipeline will call ensureChatSaved at the end
    if (save && !silent && typeof ctx.saveChat === 'function') {
        ctx.saveChat();
    }

    return messageIndex;
}

// ---------------------------------------------------------------------------
// World Info / Lorebook
// ---------------------------------------------------------------------------

/**
 * Fetches the World Info (Lorebook) prompt for the given chat history.
 * Wraps stContext.getWorldInfoPrompt() with the expected formatting.
 *
 * @param {object[]} chat - The SillyTavern chat array (filtered, no typing indicators).
 * @returns {Promise<string>} The resolved World Info prompt string.
 */
/**
 * Fetches the World Info (Lorebook) prompt for the given chat history.
 * Wraps stContext.getWorldInfoPrompt() with the expected formatting and global scan context.
 *
 * @param {object[]} chat - The SillyTavern chat array.
 * @param {boolean} [isDryRun=false] - If true, events like WORLD_INFO_ACTIVATED will not be emitted.
 * @param {string} [triggerType='normal'] - The generation trigger type (normal, quiet, etc.)
 * @returns {Promise<object>} The resolved World Info result containing before/after strings.
 */
export async function getWorldInfoForChat(chat, isDryRun = false, triggerType = 'normal', userInput = null) {
    const ctx = SillyTavern.getContext();

    if (typeof ctx.getWorldInfoPrompt !== 'function') {
        logger.warn('getWorldInfoPrompt not available.');
        return { before: '', after: '', worldInfoString: '' };
    }

    // Dynamic import to get the latest world info settings
    // SillyTavern often stores these as global variables in world-info.js
    let includeNames = true;
    try {
        const { getWorldInfoModule } = await import('./compat-st.js');
        const worldInfo = await getWorldInfoModule();
        if (worldInfo && typeof worldInfo.getWorldInfoSettings === 'function') {
            const settings = worldInfo.getWorldInfoSettings();
            includeNames = settings.world_info_include_names ?? true;
        }
    } catch (e) {
        logger.debug('Could not read world_info_include_names from settings, defaulting to true');
    }

    // Prepare the list of messages for scanning
    const messagesToScan = [...chat];

    // If we have current user input that isn't yet in the chat history, 
    // we inject it as the "latest" message to ensure keyword triggering works correctly.
    // NOTE: We check if it's already the last message to avoid double-injection 
    // if the caller already added it.
    if (userInput && userInput.trim()) {
        const lastMessage = messagesToScan[messagesToScan.length - 1];
        if (!lastMessage || lastMessage.mes !== userInput.trim()) {
            const userName = ctx.name || 'User';
            messagesToScan.push({ name: userName, mes: userInput.trim() });
            logger.debug('Injected user input into WI scan buffer:', userInput.trim());
        }
    }

    // World Info expects a reversed array of strings (ascending depth = most recent first)
    // We slice to a reasonable scan horizon to match ST native limits.
    const chatForWI = messagesToScan
        .slice(-1000)
        .map(m => includeNames ? `${m.name}: ${m.mes}` : m.mes)
        .reverse();

    // Log settings for debugging
    try {
        const wiModule = await getWorldInfoModule();
        const { world_info_recursive, world_info_depth } = wiModule || {};
        logger.debug(`World Info Settings: Recursive=${world_info_recursive}, GlobalDepth=${world_info_depth}, Trigger=${triggerType}`);
    } catch (e) { }

    const globalScanData = {
        personaDescription: ctx.persona_description || '',
        characterDescription: ctx.description || '',
        characterPersonality: ctx.personality || '',
        characterDepthPrompt: ctx.charDepthPrompt || '',
        scenario: ctx.scenario || '',
        creatorNotes: ctx.creatorNotes || '',
        trigger: triggerType,
    };

    const maxContext = await getMaxContextTokens();
    const wiResult = await ctx.getWorldInfoPrompt(chatForWI, maxContext, isDryRun, globalScanData);

    return {
        before: wiResult?.worldInfoBefore || '',
        after: wiResult?.worldInfoAfter || '',
        worldInfoString: wiResult?.worldInfoString || ''
    };
}

// ---------------------------------------------------------------------------
// Character Info
// ---------------------------------------------------------------------------

/**
 * Gets the active character's name and avatar URL.
 *
 * @returns {{ name: string, avatarUrl: string }} Character display info.
 */
export function getActiveCharacterInfo() {
    const ctx = SillyTavern.getContext();

    const name = ctx.characters?.[ctx.characterId]?.name || ctx.name2 || 'Assistant';

    let avatarUrl = '';
    if (typeof ctx.getThumbnailUrl === 'function' && ctx.characters?.[ctx.characterId]) {
        avatarUrl = ctx.getThumbnailUrl('avatar', ctx.characters[ctx.characterId].avatar);
    }

    return { name, avatarUrl };
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

/**
 * Gets the main system prompt from SillyTavern's Advanced Formatting settings.
 *
 * @returns {string} The main system prompt text.
 */
export function getMainSystemPrompt() {
    const ctx = SillyTavern.getContext();
    return ctx.extension_settings?.formatting?.main_prompt || '';
}
