import { buildStockModel, type CarVisual } from './carModel';
import { buildOpenWheelModel } from './openWheelModel';
import { addDerbyKit } from '../arena/derbyKit';
import type { CarSpec } from './catalog';

/** Build the 3D model for a car: the body comes from its spec (stock car or open-wheeler), plus any arena kit. */
export function buildCarModel(opts: { number: number; color: string; seed: number }, spec?: CarSpec): CarVisual {
  if (spec?.body === 'openWheel') return buildOpenWheelModel(opts, spec);
  const v = buildStockModel(opts);
  if (spec?.kit) addDerbyKit(v, spec.kit);
  return v;
}
