import type { Severity } from '@btfp/shared-types';

export interface Taxonomy {
  thingTypeIds: string[];
  petTypeIds: string[];
}

export type Confidence = 'high' | 'medium' | 'low';

export interface ExtractionResult {
  isPetHazardReport: boolean;
  thingName?: string;
  thingTypeId?: string;
  /** One entry per pet type the sources actually discuss; never guessed. */
  petTypes?: { petTypeId: string; severity: Severity }[];
  summary?: string;
  /** How well independent sources agree that this is a hazard. */
  confidence?: Confidence;
}
