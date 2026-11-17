// Built-in AI services. Plain data so both the shell and the preferences
// window can import it.
//
//   url    web app opened in the browser or as an app window
//   cli    command-line tool that can be opened in a terminal
//   usage  id of a usage reader in usage.js (limits shown in the menu)
//   icon   file in icons/ai/, otherwise a letter badge is drawn

export const SERVICES = [
    {id: 'claude', name: 'Claude', url: 'https://claude.ai/new', cli: 'claude', usage: 'claude', icon: 'claude.svg', color: '#d97757'},
    {id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', cli: 'codex', usage: 'codex', icon: 'codex.svg', color: '#10a37f'},
    {id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', cli: 'gemini', color: '#4285f4'},
    {id: 'copilot', name: 'GitHub Copilot', url: 'https://github.com/copilot', cli: 'copilot', usage: 'copilot', icon: 'copilot.svg', color: '#8957e5'},
    {id: 'mscopilot', name: 'Microsoft Copilot', url: 'https://copilot.microsoft.com/', color: '#0078d4'},
    {id: 'grok', name: 'Grok', url: 'https://grok.com/', cli: 'grok', icon: 'grok.svg', color: '#555555'},
    {id: 'mistral', name: 'Le Chat (Mistral)', url: 'https://chat.mistral.ai/chat', cli: 'vibe', icon: 'vibe.svg', color: '#fa520f'},
    {id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', color: '#20808d'},
    {id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', icon: 'deepseek.svg', color: '#4d6bfe'},
    {id: 'meta', name: 'Meta AI', url: 'https://www.meta.ai/', color: '#0866ff'},
    {id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/', cli: 'qwen', icon: 'qwen.svg', color: '#615ced'},
    {id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', icon: 'kimi.svg', color: '#222222'},
    {id: 'lumo', name: 'Lumo (Proton)', url: 'https://lumo.proton.me/', color: '#6d4aff'},
    {id: 'huggingchat', name: 'HuggingChat', url: 'https://huggingface.co/chat/', color: '#ff9d00'},
    {id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/chat', icon: 'openrouter.svg', color: '#6467f2'},
];

export const DEFAULT_SERVICES = ['claude', 'chatgpt', 'gemini', 'copilot'];

// Custom services are stored as JSON: [{id, name, url, cli}]
export function parseCustom(json) {
    try {
        const list = JSON.parse(json || '[]');
        return Array.isArray(list)
            ? list.filter(s => s && s.name && (s.url || s.cli)).map(s => ({
                id: String(s.id || `custom-${s.name}`),
                name: String(s.name),
                url: s.url ? String(s.url) : '',
                cli: s.cli ? String(s.cli) : '',
                custom: true,
            }))
            : [];
    } catch {
        return [];
    }
}

export function allServices(customJson) {
    return [...SERVICES, ...parseCustom(customJson)];
}

// Add a scheme when the user typed none. Addresses on the local network
// (private IPs, localhost, single-label or .local/.lan names) usually run
// plain HTTP, like LM Studio front ends or Open WebUI at home; the rest of
// the web gets HTTPS.
export function normalizeUrl(url) {
    const u = String(url || '').trim();
    if (!u)
        return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u))
        return u;
    const host = u.replace(/^\[([^\]]+)\].*$/, '$1').split(/[/:?#]/)[0].toLowerCase();
    const local = host === 'localhost' ||
        /^(127|10)\.\d+\.\d+\.\d+$/.test(host) ||
        /^192\.168\.\d+\.\d+$/.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
        /^169\.254\.\d+\.\d+$/.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) ||   // Tailscale / CGNAT
        /^(fd|fe80)/.test(host) || host.includes(':') ||
        !host.includes('.') ||
        /\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host);
    return `${local ? 'http' : 'https'}://${u}`;
}
