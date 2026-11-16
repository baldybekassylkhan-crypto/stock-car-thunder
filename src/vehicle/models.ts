import { buildStockModel, type CarVisual } from './carModel';
import { buildOpenWheelModel } from './openWheelModel';
import type { CarSpec } from './catalog';

/** Build the 3D model for a car: the body comes from its spec (stock car or open-wheeler). */
export function buildCarModel(opts: { number: number; color: string; seed: number }, spec?: CarSpec): CarVisual {
  return spec?.body === 'openWheel' ? buildOpenWheelModel(opts, spec) : buildStockModel(opts);
}
