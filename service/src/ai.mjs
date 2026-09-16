import { randomUUID } from 'node:crypto';
import { ApiError, requireThat } from './store.mjs';

const DEFAULT_ASSISTANT_BASE_URL = 'https://minelatino.net';
const MAX_UPSTREAM_BODY_CHARS = 256_000;

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function responsesOutput(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const parts = Array.isArray(payload?.output) ? payload.output.flatMap(item => Array.isArray(item?.content) ? item.content : []) : [];
  const text = parts.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
  if (text) return text;
  throw new ApiError(502, 'El proveedor de IA devolvió una respuesta inválida');
}

function chatCompletionsOutput(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
    if (text) return text;
  }
  throw new ApiError(502, 'El proveedor de IA devolvió una respuesta inválida');
}

function providerBaseUrl(value, provider) {
  const fallback = provider === 'openai' ? 'https://api.openai.com/v1' : '';
  requireThat(value || fallback, 'Configura AI_BASE_URL para el proveedor compatible', 500);
  let url;
  try { url = new URL(value || fallback); } catch { throw new Error('AI_BASE_URL inválida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('AI_BASE_URL debe ser HTTPS y no contener credenciales, query ni fragmento');
  return url.href.replace(/\/+$/, '');
}

function assistantBaseUrl(value) {
  let url;
  try { url = new URL(value || DEFAULT_ASSISTANT_BASE_URL); } catch { throw new Error('MINELATINO_ASSISTANT_URL inválida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('MINELATINO_ASSISTANT_URL debe ser HTTPS y no contener credenciales, query ni fragmento');
  return url.origin;
}

function combineSignal(clientSignal, timeoutSeconds) {
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  return clientSignal ? AbortSignal.any([clientSignal, timeoutSignal]) : timeoutSignal;
}

async function limitedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_UPSTREAM_BODY_CHARS) throw new ApiError(502, 'El asistente oficial devolvió una respuesta demasiado grande');
  const text = await response.text();
  if (text.length > MAX_UPSTREAM_BODY_CHARS) throw new ApiError(502, 'El asistente oficial devolvió una respuesta demasiado grande');
  return text;
}

function csrfToken(html) {
  const byNameFirst = html.match(/<meta\b[^>]*\bname=["']csrf-token["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i);
  const byContentFirst = html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']csrf-token["'][^>]*>/i);
  const token = (byNameFirst?.[1] || byContentFirst?.[1] || '').trim();
  return token.length > 0 && token.length <= 512 ? token : '';
}

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map(value => String(value).split(';', 1)[0].trim())
    .filter(value => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/.test(value)).join('; ');
}

function websiteConversation(messages) {
  const safe = messages.filter(message => ['user', 'assistant'].includes(message?.role)
    && typeof message?.content === 'string' && message.content.trim());
  const current = safe.findLastIndex(message => message.role === 'user');
  requireThat(current >= 0, 'Mensaje requerido');
  return {
    question: safe[current].content.trim(),
    history: safe.slice(0, current).slice(-6).map(({ role, content }) => ({ role, content: content.trim() })),
  };
}

function officialWebsiteComplete({ baseUrl, fetchImpl, timeoutSeconds }) {
  return async (messages, clientSignal) => {
    const signal = combineSignal(clientSignal, timeoutSeconds);
    let page;
    try {
      page = await fetchImpl(`${baseUrl}/asistente`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'text/html', 'User-Agent': 'MineLatino-InGame-Assistant/0.1' },
      });
    } catch { throw new ApiError(503, 'El asistente oficial no está disponible'); }
    if (!page.ok) throw new ApiError(502, 'No se pudo iniciar una sesión con el asistente oficial');

    const html = await limitedText(page);
    const csrf = csrfToken(html);
    const cookie = cookieHeader(page.headers);
    if (!csrf || !cookie) throw new ApiError(502, 'La sesión del asistente oficial es inválida');

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/assistant/message`, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': csrf,
          Cookie: cookie, 'User-Agent': 'MineLatino-InGame-Assistant/0.1',
        },
        body: JSON.stringify(websiteConversation(messages)),
      });
    } catch { throw new ApiError(503, 'El asistente oficial no está disponible'); }

    let payload;
    try { payload = JSON.parse(await limitedText(response)); } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'El asistente oficial devolvió una respuesta inválida');
    }
    if (!response.ok || payload?.success !== true) {
      const message = typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim().slice(0, 500)
        : response.status === 429 ? 'El asistente está ocupado; inténtalo más tarde' : 'El asistente oficial rechazó la solicitud';
      throw new ApiError(response.status === 429 ? 429 : 502, message);
    }
    const content = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    if (!content) throw new ApiError(502, 'El asistente oficial devolvió una respuesta vacía');
    return { content, usage: {} };
  };
}

function directProviderComplete({ fetchImpl, timeoutSeconds }) {
  const provider = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const apiKey = String(process.env.AI_API_KEY || '').trim();
  const model = String(process.env.AI_MODEL || '').trim();
  if (!provider || !apiKey || !model) return undefined;
  if (!['openai','openai-compatible'].includes(provider)) throw new Error('AI_PROVIDER no admitido');
  const baseUrl = providerBaseUrl(String(process.env.AI_BASE_URL || '').trim(), provider);
  const style = String(process.env.AI_API_STYLE || (provider === 'openai' ? 'responses' : 'chat-completions')).trim().toLowerCase();
  if (!['responses','chat-completions'].includes(style)) throw new Error('AI_API_STYLE no admitido');
  return async (messages, clientSignal) => {
    let response;
    try {
      const endpoint = `${baseUrl}/${style === 'responses' ? 'responses' : 'chat/completions'}`;
      const requestBody = style === 'responses'
        ? { model, input: messages.map(({ role, content }) => ({ role, content: [{ type: 'input_text', text: content }] })) }
        : { model, messages: messages.map(({ role, content }) => ({ role, content })) };
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: combineSignal(clientSignal, timeoutSeconds),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    } catch { throw new ApiError(503, 'El proveedor de IA no está disponible'); }
    if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502,
      response.status === 429 ? 'El asistente está ocupado; inténtalo más tarde' : 'El proveedor de IA rechazó la solicitud');
    let payload;
    try { payload = await response.json(); } catch { throw new ApiError(502, 'El proveedor de IA devolvió una respuesta inválida'); }
    return { content: style === 'responses' ? responsesOutput(payload) : chatCompletionsOutput(payload), usage: {
      inputTokens: integer(style === 'responses' ? payload?.usage?.input_tokens : payload?.usage?.prompt_tokens, 0, 0, Number.MAX_SAFE_INTEGER),
      outputTokens: integer(style === 'responses' ? payload?.usage?.output_tokens : payload?.usage?.completion_tokens, 0, 0, Number.MAX_SAFE_INTEGER),
    } };
  };
}

export function createAiServiceFromEnv({ store, fetchImpl = fetch, now = Date.now } = {}) {
  const source = String(process.env.AI_SOURCE || 'minelatino-web').trim().toLowerCase();
  const timeoutSeconds = integer(process.env.AI_REQUEST_TIMEOUT_SECONDS, 60, 5, 120);
  let complete;
  if (source === 'minelatino-web') {
    complete = officialWebsiteComplete({
      baseUrl: assistantBaseUrl(String(process.env.MINELATINO_ASSISTANT_URL || '').trim()),
      fetchImpl, timeoutSeconds,
    });
  } else if (source === 'direct') {
    complete = directProviderComplete({ fetchImpl, timeoutSeconds });
    if (!complete) return undefined;
  } else {
    throw new Error('AI_SOURCE no admitido');
  }
  return new AiService({ store, complete, now,
    maxMessageChars: integer(process.env.AI_MAX_MESSAGE_CHARS, 4000, 256, 8000),
    maxContextMessages: integer(process.env.AI_MAX_CONTEXT_MESSAGES, 30, 2, 60),
    dailyRequestLimit: integer(process.env.AI_DAILY_REQUEST_LIMIT, 100, 1, 10_000),
  });
}

export class AiService {
  constructor({ store, complete, now = Date.now, maxMessageChars = 4000, maxContextMessages = 30, dailyRequestLimit = 100 }) {
    this.store = store; this.complete = complete; this.now = now;
    this.maxMessageChars = maxMessageChars; this.maxContextMessages = maxContextMessages;
    this.dailyRequestLimit = dailyRequestLimit;
    this.activeAccounts = new Set();
    this.recentRequests = new Map();
  }

  status() { return { enabled: true, maxMessageChars: this.maxMessageChars, maxContextMessages: this.maxContextMessages }; }

  async chat(accountId, input, signal) {
    requireThat(input && typeof input === 'object', 'Solicitud inválida');
    requireThat(typeof input.message === 'string', 'Mensaje requerido');
    const message = input.message.trim();
    requireThat(message.length > 0 && message.length <= this.maxMessageChars, `El mensaje admite hasta ${this.maxMessageChars} caracteres`);
    requireThat(typeof input.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(input.requestId), 'Identificador de solicitud inválido');
    requireThat(input.conversationId === null || input.conversationId === undefined
      || (typeof input.conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(input.conversationId)), 'Conversación inválida');
    const used = this.store.aiUsageSince(accountId, this.now() - 24 * 60 * 60 * 1000);
    requireThat(used.requests < this.dailyRequestLimit, 'Límite diario del asistente alcanzado', 429);
    const minute = this.now() - 60_000;
    const recent = (this.recentRequests.get(accountId) || []).filter(value => value > minute);
    requireThat(recent.length < 10, 'Espera antes de enviar más mensajes', 429);
    requireThat(!this.activeAccounts.has(accountId), 'Ya existe una respuesta en curso', 409);
    requireThat(this.activeAccounts.size < 20, 'El asistente está ocupado; inténtalo más tarde', 503);
    recent.push(this.now()); this.recentRequests.set(accountId, recent); this.activeAccounts.add(accountId);

    try {
      const conversationId = this.store.ensureAiConversation(accountId, input.conversationId || randomUUID(), this.now());
      const previous = this.store.aiRequest(accountId, input.requestId);
      if (previous?.status === 'complete') return this.store.aiCompletedResponse(accountId, input.requestId);
      requireThat(!previous, 'La solicitud ya está en curso', 409);
      this.store.beginAiRequest(accountId, input.requestId, conversationId, this.now());
      const context = this.store.aiContext(accountId, conversationId, this.maxContextMessages - 1);
      const result = await this.complete([...context, { role: 'user', content: message }], signal);
      requireThat(result && typeof result.content === 'string' && result.content.trim().length > 0,
        'El asistente oficial devolvió una respuesta vacía', 502);
      const content = result.content.trim().slice(0, 16_000);
      return this.store.completeAiRequest(accountId, input.requestId, conversationId, message, content,
        result.usage || {}, this.now());
    } catch (error) {
      this.store.failAiRequest(accountId, input.requestId);
      throw error;
    } finally {
      this.activeAccounts.delete(accountId);
    }
  }
}
