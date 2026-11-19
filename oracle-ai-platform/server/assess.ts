// Dispatcher kept for existing imports; each product module owns its own assessment logic.
export {
  assess,
  selectRecords,
  simulate,
  candidates,
  moduleFor,
  MODULES,
} from "./modules";
export type { AssessmentMeta } from "./modules/common";
