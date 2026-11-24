import { BpmnModdle } from 'bpmn-moddle';

const moddle = new BpmnModdle();

/** Renvoie null si le XML est un BPMN lisible, sinon le message d'erreur. */
export async function checkBpmn(xml) {
  try {
    const { rootElement } = await moddle.fromXML(xml, 'bpmn:Definitions');
    if (!rootElement?.rootElements?.length) return 'Le fichier ne contient aucun processus.';
    return null;
  } catch (e) {
    return `XML BPMN invalide : ${e.message}`;
  }
}
