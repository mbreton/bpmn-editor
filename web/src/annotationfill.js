// bpmn-js ne remplit jamais le fond d'un commentaire (TextAnnotation) : on dessine le fond choisi
// (couleur de remplissage du commentaire), légèrement transparent, derrière le texte.
import BaseRenderer from 'diagram-js/lib/draw/BaseRenderer';
import { is, getDi } from 'bpmn-js/lib/util/ModelUtil';

const fillOf = el => { const di = getDi(el); return di?.get?.('color:background-color') || di?.get?.('bioc:fill'); };

class AnnotationFillRenderer extends BaseRenderer {
  constructor(eventBus, bpmnRenderer) {
    super(eventBus, 1500);
    this.bpmnRenderer = bpmnRenderer;
  }
  canRender(el) { return is(el, 'bpmn:TextAnnotation') && !el.labelTarget && !!fillOf(el); }
  drawShape(parentGfx, el) {
    const rect = this.bpmnRenderer.drawShape(parentGfx, el);
    // bpmn-js pose « fill: none » en style : on le remplace au même endroit
    rect.style.fill = fillOf(el);
    rect.style.fillOpacity = '0.6';
    rect.setAttribute('rx', '3');
    return rect;
  }
  getShapePath(el) { return this.bpmnRenderer.getShapePath(el); }
}
AnnotationFillRenderer.$inject = ['eventBus', 'bpmnRenderer'];

export default { __init__: ['annotationFillRenderer'], annotationFillRenderer: ['type', AnnotationFillRenderer] };
