// Assistant IA conversationnel : relais en streaming vers un LLM (Anthropic ou API compatible OpenAI).
// L'IA discute du diagramme, puis propose des modifications sous forme d'opérations JSON que
// l'éditeur applique une par une (l'utilisateur accepte ou refuse chacune).

export const OPS_SPEC = `Each change is an object:
{ "title": "short title in French",
  "why": "why this change, in French (1-2 sentences)",
  "benefit": "what it brings, in French (1 sentence)",
  "focus": ["ids of the existing or new elements to zoom on"],
  "ops": [ ...operations, applied in order... ] }

Operations (use existing ids from the diagram; give new elements a readable unique "ref" such as "Timer_RelanceKyc", reusable by later operations of the same or later changes):
- {"op":"update","id":"<id>","name":"…","documentation":"…"}                       (only the fields to change)
- {"op":"append","ref":"<newId>","after":"<id>","type":"bpmn:UserTask","name":"…"}  (creates the element after <id>, linked by a sequence flow; optional "flowName", "condition")
- {"op":"insert","ref":"<newId>","flow":"<sequenceFlowId>","type":"…","name":"…"}   (splits an existing sequence flow and puts the element in the middle)
- {"op":"attach","ref":"<newId>","to":"<activityId>","event":"timer","interrupting":false,"name":"…"}  (boundary event on an activity or sub-process)
- {"op":"connect","ref":"<newFlowId>","from":"<id>","to":"<id>","name":"…","condition":"\${…}"}
- {"op":"replace","id":"<id>","type":"bpmn:ServiceTask"}                             (change element type, keeps connections; for events also "event")
- {"op":"delete","id":"<id>"}
- {"op":"set_timer","id":"<eventId>","kind":"timeDuration|timeDate|timeCycle","value":"P3D"}
- {"op":"set_interrupting","id":"<boundaryOrEventSubprocessStartId>","value":false}
- {"op":"set_condition","id":"<sequenceFlowId>","expression":"\${montant > 1000}"}
- {"op":"set_default","gateway":"<gatewayId>","flow":"<sequenceFlowId>"}
- {"op":"set_error","id":"<eventId>","name":"Dossier expiré","code":"DOSSIER_EXPIRE"}   (also set_message / set_signal / set_escalation with "name")

Element types: bpmn:Task, bpmn:UserTask, bpmn:ServiceTask, bpmn:ScriptTask, bpmn:SendTask, bpmn:ReceiveTask, bpmn:ManualTask, bpmn:BusinessRuleTask, bpmn:CallActivity, bpmn:SubProcess, bpmn:StartEvent, bpmn:EndEvent, bpmn:IntermediateCatchEvent, bpmn:IntermediateThrowEvent, bpmn:ExclusiveGateway, bpmn:ParallelGateway, bpmn:InclusiveGateway, bpmn:EventBasedGateway, bpmn:TextAnnotation.
"event" (for events, attach and replace): none | timer | message | error | signal | escalation | compensate | conditional | terminate. With "event":"timer" you may add "timer":{"kind":"timeDuration","value":"P3D"}.
Timers use ISO 8601: P3D, PT48H, R3/P1D (3 times, every day), or an expression like \${dueDate} with kind timeDate.`;

export const SYSTEM_PROMPT = `You are a senior BPMN 2.0 consultant embedded in a diagram editor used by French-speaking teams. You talk with the user about THEIR diagram, which is given to you as BPMN 2.0 XML (layout information removed) in each of their messages, always up to date.

How to behave:
- Answer in French, concise and concrete. Light markdown only: short paragraphs, "- " bullet lists, **bold**. No tables, no headings, no code blocks.
- Refer to elements by their name (and id in backticks when it helps, e.g. \`Task_KYC\`).
- Discuss, explain, challenge the model and ask clarifying questions when the intent is unclear. It is a conversation: take every remark of the user into account in later answers.
- NEVER output BPMN XML.
- Only when the user asks you to apply, make, propose or implement changes (or when the message says "MODE PROPOSITION"), end your answer with ONE block:
<changes>[ ...array of changes... ]</changes>
  Before the block, write one or two sentences summarising what you will propose. Split the work into small changes that the user can accept or refuse one by one (one concern per change, ordered so that each change makes sense even if a later one is refused). A change must not depend on an earlier change of the same block unless unavoidable; if it does, say so in "why".
- Prefer the minimal set of changes that matches what was agreed in the conversation. When asked to review the whole diagram, propose each improvement as its own change.

${OPS_SPEC}

Example of a block:
<changes>[{"title":"Relancer le client tous les jours","why":"La collecte des pièces peut durer et rien ne relance le client.","benefit":"Moins de dossiers bloqués sans action.","focus":["Task_KYC","Timer_Relance"],"ops":[{"op":"attach","ref":"Timer_Relance","to":"Task_KYC","event":"timer","interrupting":false,"name":"Chaque jour (x3)","timer":{"kind":"timeCycle","value":"R3/P1D"}},{"op":"append","ref":"Task_Relancer","after":"Timer_Relance","type":"bpmn:SendTask","name":"Relancer le client"},{"op":"append","ref":"End_Relance","after":"Task_Relancer","type":"bpmn:EndEvent","name":"Relance envoyée"}]}]</changes>`;

/** Retire la DI (coordonnées) : inutile au modèle, et coûteuse en jetons. */
export function stripDi(xml) {
  return String(xml).replace(/<(\w+:)?BPMNDiagram\b[\s\S]*?<\/(\w+:)?BPMNDiagram>/g, '').replace(/\n\s*\n+/g, '\n');
}

export class AiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function* sseLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  if (buf) yield buf;
}

export function createAi(cfg) {
  const provider = (cfg.provider || 'anthropic').toLowerCase();
  const enabled = !!cfg.apiKey || (provider === 'openai' && !!cfg.baseUrl);
  const model = cfg.model || (provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1');
  const timeout = cfg.timeoutMs || 300_000;

  async function* streamAnthropic(system, messages, maxTokens, signal) {
    const res = await fetch((cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true }),
      signal
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new AiError(`Le fournisseur IA a répondu ${res.status} : ${body?.error?.message || 'erreur inconnue'}`);
    }
    for await (const line of sseLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield ev.delta.text;
      if (ev.type === 'error') throw new AiError(`Erreur du fournisseur IA : ${ev.error?.message || 'inconnue'}`);
    }
  }

  async function* streamOpenAi(system, messages, maxTokens, signal) {
    const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: 'system', content: system }, ...messages] })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new AiError(`Le fournisseur IA a répondu ${res.status} : ${body?.error?.message || 'erreur inconnue'}`);
    }
    for await (const line of sseLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const t = ev.choices?.[0]?.delta?.content;
      if (t) yield t;
    }
  }

  /**
   * history : [{ role: 'user'|'assistant', content }] — le dernier message est celui de l'utilisateur.
   * Le diagramme à jour est joint au dernier message ; mode 'propose' force un bloc <changes>.
   */
  function buildMessages({ xml, history, mode, selection }) {
    const msgs = [];
    for (const m of history) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (msgs.length && msgs.at(-1).role === role) msgs.at(-1).content += `\n\n${m.content}`;
      else msgs.push({ role, content: String(m.content) });
    }
    if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '(début de conversation)' });
    const last = msgs.at(-1);
    if (last.role !== 'user') throw new AiError('Le dernier message doit venir de l\'utilisateur.', 400);
    const sel = selection?.length ? `\nÉléments sélectionnés dans l'éditeur : ${selection.map(s => `${s.name || '(sans nom)'} [${s.id}]`).join(', ')}\n` : '';
    const propose = mode === 'propose' ? '\n\nMODE PROPOSITION : propose maintenant les modifications issues de notre échange, sous forme de bloc <changes>.' : '';
    last.content = `Diagramme actuel :\n<diagram>\n${stripDi(xml)}\n</diagram>\n${sel}\n${last.content}${propose}`;
    return msgs;
  }

  /** Générateur de morceaux de texte. */
  async function* chat({ xml, history, mode, selection }, signal) {
    const messages = buildMessages({ xml, history, mode, selection });
    const maxTokens = mode === 'propose' ? 16000 : 6000;
    const abort = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
    const gen = provider === 'anthropic' ? streamAnthropic(SYSTEM_PROMPT, messages, maxTokens, abort) : streamOpenAi(SYSTEM_PROMPT, messages, maxTokens, abort);
    yield* gen;
  }

  return { enabled, model, provider, chat, buildMessages };
}
