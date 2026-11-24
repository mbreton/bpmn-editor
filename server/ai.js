// Assistant IA : relais vers un LLM (Anthropic ou API compatible OpenAI), avec validation du BPMN produit.
import { BpmnModdle } from 'bpmn-moddle';

export const SYSTEM_PROMPT = `You are a senior BPMN 2.0 modeler embedded in a diagram editor used by French-speaking business and tech teams.

You receive the CURRENT diagram as BPMN 2.0 XML (with BPMN DI) and a change request in French. You return the COMPLETE updated diagram.

Hard rules:
1. Output exactly two blocks and nothing else, no markdown fences:
   <explanation>Short list of what you changed, in French, one change per line starting with "- ". Mention any assumption you made.</explanation>
   <bpmn>THE FULL UPDATED BPMN 2.0 XML DOCUMENT</bpmn>
2. Keep every element, id, attribute, extension element and namespace that the request does not ask you to change. Never rename existing ids.
3. Keep existing DI (BPMNShape bounds, BPMNEdge waypoints) unchanged, except to shift elements so new ones fit without overlapping. Every new flow node, data object, annotation, participant and lane MUST get a BPMNShape; every new sequence flow, message flow and association MUST get a BPMNEdge with orthogonal waypoints that touch the shapes' borders. Tasks are 100x80, events 36x36, gateways 50x50. Place new elements left-to-right following the flow, about 50-80px apart.
4. Keep the model consistent: incoming/outgoing references match the sequence flows; boundary events use attachedToRef and are placed on the border of their host shape; non-interrupting boundary events use cancelActivity="false"; event sub-processes use triggeredByEvent="true" and their start event's isInterrupting; errors, messages, signals and escalations referenced by event definitions are declared as root elements of definitions.
5. Timers use ISO 8601 inside a formal expression, e.g. <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">P3D</bpmn:timeDuration>, timeCycle "R3/P1D", or timeDate. Declare xmlns:xsi if you use xsi:type.
6. Labels (name attributes) are in French, short, verb + object for tasks, past participle or state for events.
7. If the request is ambiguous, choose the most standard BPMN interpretation and say so in the explanation. If it cannot be done, return the diagram unchanged and explain why.`;

const MAX_TOKENS = 32000;

export function createAi(cfg) {
  const provider = (cfg.provider || 'anthropic').toLowerCase();
  const enabled = !!cfg.apiKey || (provider === 'openai' && !!cfg.baseUrl);
  const model = cfg.model || (provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1');
  const moddle = new BpmnModdle();

  async function callAnthropic(system, messages) {
    const res = await fetch((cfg.baseUrl || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages }),
      signal: AbortSignal.timeout(cfg.timeoutMs || 240_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(`Le fournisseur IA a répondu ${res.status} : ${body?.error?.message || 'erreur inconnue'}`, 502);
    return (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  async function callOpenAi(system, messages) {
    const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, ...messages] }),
      signal: AbortSignal.timeout(cfg.timeoutMs || 240_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(`Le fournisseur IA a répondu ${res.status} : ${body?.error?.message || 'erreur inconnue'}`, 502);
    return body.choices?.[0]?.message?.content || '';
  }

  const call = (system, messages) => provider === 'anthropic' ? callAnthropic(system, messages) : callOpenAi(system, messages);

  /** Contrôle structurel : XML lisible par bpmn-moddle, et chaque élément visible a sa DI. */
  async function validate(xml) {
    const problems = [];
    let definitions;
    try {
      const r = await moddle.fromXML(xml, 'bpmn:Definitions');
      definitions = r.rootElement;
      for (const w of r.warnings || []) problems.push(w.message);
    } catch (e) {
      return [`XML invalide : ${e.message}`];
    }
    const withDi = new Set();
    for (const diagram of definitions.diagrams || []) {
      for (const el of diagram.plane?.planeElement || []) if (el.bpmnElement) withDi.add(el.bpmnElement.id);
    }
    const visible = [];
    const walk = container => {
      for (const el of container.flowElements || []) {
        visible.push(el);
        if (el.flowElements) walk(el);
      }
      for (const a of container.artifacts || []) visible.push(a);
      for (const lane of container.laneSets?.flatMap(s => s.lanes || []) || []) visible.push(lane);
    };
    for (const root of definitions.rootElements || []) {
      if (root.$type === 'bpmn:Process') walk(root);
      if (root.$type === 'bpmn:Collaboration') {
        for (const p of root.participants || []) visible.push(p);
        for (const m of root.messageFlows || []) visible.push(m);
      }
    }
    const missing = visible.filter(el => !withDi.has(el.id) && el.$type !== 'bpmn:DataObject');
    if (missing.length) problems.push(`Éléments sans représentation graphique (DI) : ${missing.slice(0, 15).map(e => e.id).join(', ')}`);
    return problems;
  }

  function parse(text) {
    const explanation = /<explanation>([\s\S]*?)<\/explanation>/i.exec(text)?.[1]?.trim() || '';
    let xml = /<bpmn>([\s\S]*?)<\/bpmn>/i.exec(text)?.[1]?.trim() || '';
    xml = xml.replace(/^```(?:xml)?\s*/i, '').replace(/\s*```$/, '');
    return { explanation, xml };
  }

  /**
   * turns: [{ request, proposalXml?, explanation? }] — le dernier tour n'a pas encore de proposition.
   */
  async function propose({ xml, turns }) {
    const messages = [];
    turns.forEach((t, i) => {
      const content = i === 0
        ? `Diagramme actuel :\n<current>\n${xml}\n</current>\n\nDemande : ${t.request}`
        : `Précision sur ta proposition précédente : ${t.request}\nRepars de ta dernière proposition et renvoie le diagramme complet.`;
      messages.push({ role: 'user', content });
      if (t.proposalXml) messages.push({ role: 'assistant', content: `<explanation>${t.explanation || ''}</explanation>\n<bpmn>${t.proposalXml}</bpmn>` });
    });

    let text = await call(SYSTEM_PROMPT, messages);
    let out = parse(text);
    let problems = out.xml ? await validate(out.xml) : ['Réponse sans bloc <bpmn>.'];

    // Une passe de correction automatique si le résultat est invalide.
    if (problems.length) {
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `Ta réponse pose ces problèmes :\n- ${problems.join('\n- ')}\nCorrige-les et renvoie les deux blocs complets.` });
      text = await call(SYSTEM_PROMPT, messages);
      out = parse(text);
      problems = out.xml ? await validate(out.xml) : ['Réponse sans bloc <bpmn>.'];
      if (problems.length && !out.xml) throw new AiError("L'IA n'a pas renvoyé de diagramme exploitable. Reformulez la demande.", 502);
    }
    return { explanation: out.explanation, xml: out.xml, warnings: problems, model };
  }

  return { enabled, model, provider, propose, validate };
}

export class AiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
