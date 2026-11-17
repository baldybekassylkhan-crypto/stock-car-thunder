import { buildStockModel, type CarVisual } from './carModel';
import { buildOpenWheelModel } from './openWheelModel';
import { addDerbyKit } from '../arena/derbyKit';
import type { CarSpec } from './catalog';
import { applyCarStyle } from './carStyles';

/** Build the 3D model for a car: the body comes from its spec (stock car or open-wheeler), plus any arena kit. */
export function buildCarModel(opts: { number: number; color: string; seed: number }, spec?: CarSpec): CarVisual {
  if (spec?.body === 'openWheel') {
    const ow = buildOpenWheelModel(opts, spec);
    applyCarStyle(ow, spec);
    return ow;
  }
  const v = buildStockModel(opts);
  if (spec && !spec.kit) applyCarStyle(v, spec);
  if (spec?.kit) addDerbyKit(v, spec.kit);
  return v;
}
